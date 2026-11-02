// squareTokenRefresher: keeps Connect Square (OAuth) venues' Square access
// tokens fresh. Runs daily on a schedule.
//
// Square OAuth access tokens expire 30 days after they're issued; the
// refresh token from the code flow doesn't expire unless the seller
// revokes access. Each run:
//   1. finds OAuth venues: one Secrets Manager secret per venue,
//      indieTix/square/clients/<clientId>, holding {"refresh_token"} (QRScanner's
//      SQUARE OAUTH callback creates it)
//   2. skips a venue whose token has more than REFRESH_WHEN_DAYS_LEFT days
//      left, so each token is refreshed about weekly (Square's advice)
//   3. otherwise trades the refresh token for a new access token and saves
//      it to the venue's existing SQUARE_ACCESS_TOKEN, which every Lambda
//      already reads
//   4. emails the venue (and OPERATOR_ALERT_EMAIL) when a refresh fails,
//      and says so plainly when Square reports access was revoked
//
// One venue's failure never stops the others, and the run never throws:
// a scheduled retry would only repeat the same failures. Tokens are never
// logged. Configuration (environment variables, set by bootstrap.sh):
//   SQUARE_APP_ID, SQUARE_APP_SECRET_ID  the Square app (as QRScanner uses)
//   SQUARE_API_BASE                      Square production unless set
//   OPERATOR_ALERT_EMAIL                 optional: copied on every alert
import pg from 'pg';
import {
  SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, ListSecretsCommand
} from '@aws-sdk/client-secrets-manager';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';

const REFRESH_SECRET_PREFIX = 'indieTix/square/clients/';
const DAY_MS = 24 * 60 * 60 * 1000;
// 30-day tokens refreshed once fewer than 23 days remain = about weekly.
export const REFRESH_WHEN_DAYS_LEFT = 23;

const region = process.env.AWS_REGION || 'us-east-2';
const secretsClient = new SecretsManagerClient({ region });
const sesClient = new SESClient({ region });

function squareApiBase() {
  return (process.env.SQUARE_API_BASE || 'https://connect.squareup.com').replace(/\/+$/, '');
}

// ---- VENUES ----

// Client IDs of every venue with a refresh-token secret (OAuth venues).
export async function listOAuthVenues(secrets = secretsClient) {
  const ids = [];
  let NextToken;
  do {
    const page = await secrets.send(new ListSecretsCommand({
      Filters: [{ Key: 'name', Values: [REFRESH_SECRET_PREFIX] }],
      NextToken
    }));
    for (const secret of page.SecretList || []) {
      const id = (secret.Name || '').slice(REFRESH_SECRET_PREFIX.length);
      if (secret.Name.startsWith(REFRESH_SECRET_PREFIX) && /^[A-Za-z0-9]+$/.test(id)) ids.push(id);
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return ids.sort();
}

async function readSecretJson(secrets, SecretId) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(response.SecretString);
}

// A connection to the venue's own database, from its own credentials
// secret (the same pattern QRScanner uses).
export async function connectVenue(clientId, secrets = secretsClient) {
  const creds = await readSecretJson(secrets, `indieTix/rds/clients/${clientId}/credentials`);
  const client = new pg.Client({
    host: creds.host,
    port: parseInt(creds.port || '5432'),
    database: clientId,
    user: creds.username,
    password: creds.password,
    ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false,
    // An auto-paused Aurora takes ~15s to resume on the first connection.
    connectionTimeoutMillis: 20000
  });
  await client.connect();
  return client;
}

async function loadVenue(db, clientId) {
  const { rows } = await db.query('SELECT "configuration", "clientEmail" FROM "Client" WHERE "clientID" = $1', [clientId]);
  if (!rows.length) throw new Error('no Client row');
  const config = typeof rows[0].configuration === 'string' ? JSON.parse(rows[0].configuration) : rows[0].configuration;
  return { config: config || {}, contactEmail: rows[0].clientEmail || null };
}

// ---- REFRESH ----

export function isRefreshDue(expiresAt, now = Date.now()) {
  const expires = Date.parse(expiresAt || '');
  if (Number.isNaN(expires)) return true;
  return expires - now < REFRESH_WHEN_DAYS_LEFT * DAY_MS;
}

// Refreshes one venue. Returns { clientId, status, ... } where status is
// 'refreshed', 'not-due', 'skipped' (not on OAuth any more) or 'failed'.
// Never throws.
export async function refreshVenue(clientId, { secrets = secretsClient, db, appId, appSecret, now = Date.now(), fetchFn = fetch }) {
  let venue;
  try {
    venue = await loadVenue(db, clientId);
  } catch (error) {
    return { clientId, status: 'failed', error: `couldn't read the venue's settings (${error.message})` };
  }
  const { config } = venue;
  if (config.SQUARE_AUTH_MODE !== 'oauth') {
    return { clientId, venue, status: 'skipped', reason: 'venue uses a personal access token' };
  }
  if (!isRefreshDue(config.SQUARE_TOKEN_EXPIRES_AT, now)) {
    return { clientId, venue, status: 'not-due', expiresAt: config.SQUARE_TOKEN_EXPIRES_AT };
  }

  try {
    const secretName = `${REFRESH_SECRET_PREFIX}${clientId}`;
    const { refresh_token: refreshToken } = await readSecretJson(secrets, secretName);
    if (!refreshToken) throw new Error('the refresh-token secret is empty');

    const response = await fetchFn(`${squareApiBase()}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || !tokens.access_token) {
      const codes = (tokens.errors || []).map(e => e.code).filter(Boolean);
      // A refresh token is only refused like this once the seller has
      // revoked IndieTix's access in Square: reconnecting is the fix.
      const revoked = response.status === 401 || codes.some(c => /UNAUTHORIZED|REVOKED|INVALID_GRANT/i.test(c));
      return {
        clientId, venue, status: 'failed', revoked,
        expiresAt: config.SQUARE_TOKEN_EXPIRES_AT,
        error: `Square refused the refresh (HTTP ${response.status}${codes.length ? `, ${codes.join(', ')}` : ''})`
      };
    }

    await db.query(
      `UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb, "updatedDate" = CURRENT_TIMESTAMP WHERE "clientID" = $2`,
      [JSON.stringify({ SQUARE_ACCESS_TOKEN: tokens.access_token, SQUARE_TOKEN_EXPIRES_AT: tokens.expires_at || null }), clientId]
    );
    // The code flow normally hands back the same refresh token; keep a new
    // one if Square ever issues it.
    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      await secrets.send(new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: JSON.stringify({ refresh_token: tokens.refresh_token })
      }));
    }
    return { clientId, venue, status: 'refreshed', expiresAt: tokens.expires_at || null };
  } catch (error) {
    return { clientId, venue, status: 'failed', expiresAt: config.SQUARE_TOKEN_EXPIRES_AT, error: error.message };
  }
}

// ---- ALERTS ----

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

// An email for a failed refresh: to the venue's contact (and
// OWNER_BCC_EMAIL), plus the operator, from the venue's SENDER_EMAIL.
// Returns null when there's nothing to say or nobody to say it to.
export function buildRefreshAlert(result, operatorEmail) {
  if (!result || result.status !== 'failed') return null;
  const config = (result.venue && result.venue.config) || {};
  const from = cleanHeader(config.SENDER_EMAIL);
  const to = [...new Set([result.venue && result.venue.contactEmail, config.OWNER_BCC_EMAIL, operatorEmail]
    .map(cleanHeader).filter(e => e.includes('@')))];
  if (!from || !to.length) return null;
  const venueName = cleanHeader(config.WEB_HEADER_COMPANY || config.THEATER_NAME || result.clientId);
  const expires = result.expiresAt ? new Date(result.expiresAt) : null;
  const expiryLine = expires && !Number.isNaN(expires.getTime())
    ? `Square access for ${venueName} expires ${expires.toUTCString()}. After that, ticket emails and the rest of IndieTix's Square features stop until it's fixed.`
    : `${venueName}'s Square access may already have expired.`;
  const text = [
    result.revoked
      ? `Square says IndieTix's access to ${venueName}'s Square account was removed, so it couldn't be renewed.`
      : `IndieTix couldn't renew ${venueName}'s connection to Square.`,
    '',
    expiryLine,
    '',
    result.revoked
      ? 'To fix it: open Client Settings in IndieTix and click "Reconnect Square".'
      : 'IndieTix tries again every day. If this keeps happening, open Client Settings and click "Reconnect Square".',
    '',
    `Details: ${result.error}`,
    `Venue ID: ${result.clientId}`
  ].join('\n');
  return {
    clientId: result.clientId,
    from,
    to,
    subject: `IndieTix: Square connection needs attention for ${venueName}`,
    text
  };
}

export async function sendAlert(alert, ses = sesClient) {
  if (!alert) return null;
  const raw = [
    `From: ${alert.from}`,
    `To: ${alert.to.join(', ')}`,
    `Subject: ${alert.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    alert.text
  ].join('\r\n');
  try {
    await ses.send(new SendRawEmailCommand({ Source: alert.from, Destinations: alert.to, RawMessage: { Data: Buffer.from(raw, 'utf8') } }));
    console.log(`REFRESH ALERT sent for ${alert.clientId} to ${alert.to.length} recipient(s)`);
    return { clientId: alert.clientId, sent: true };
  } catch (error) {
    console.error(`REFRESH ALERT failed to send for ${alert.clientId}: ${error.message}`);
    return { clientId: alert.clientId, sent: false, reason: error.message };
  }
}

// ---- HANDLER ----

export const handler = async () => {
  const appId = process.env.SQUARE_APP_ID;
  const appSecretId = process.env.SQUARE_APP_SECRET_ID;
  if (!appId || !appSecretId) {
    console.log('Connect Square is not set up here (no SQUARE_APP_ID / SQUARE_APP_SECRET_ID); nothing to refresh.');
    return { refreshed: 0, failed: 0, results: [] };
  }

  let appSecret, venues;
  try {
    appSecret = (await readSecretJson(secretsClient, appSecretId)).client_secret;
    if (!appSecret) throw new Error('the app secret has no client_secret');
    venues = await listOAuthVenues();
  } catch (error) {
    console.error(`REFRESH FAILED before any venue: ${error.message}`);
    return { refreshed: 0, failed: 0, error: error.message, results: [] };
  }
  console.log(`Square token refresh: ${venues.length} Connect Square venue(s)`);

  const results = [];
  for (const clientId of venues) {
    let db;
    let result;
    try {
      db = await connectVenue(clientId);
      result = await refreshVenue(clientId, { db, appId, appSecret });
    } catch (error) {
      result = { clientId, status: 'failed', error: `couldn't open the venue's database (${error.message})` };
    } finally {
      if (db) await db.end().catch(() => {});
    }
    console.log(`${clientId}: ${result.status}${result.expiresAt ? ` (expires ${result.expiresAt})` : ''}${result.error ? ` -- ${result.error}` : ''}`);
    if (result.status === 'failed') {
      console.error(`REFRESH FAILED for ${clientId}${result.revoked ? ' (access revoked)' : ''}`);
      result.alert = await sendAlert(buildRefreshAlert(result, process.env.OPERATOR_ALERT_EMAIL));
    }
    delete result.venue;
    results.push(result);
  }

  const count = status => results.filter(r => r.status === status).length;
  const summary = { refreshed: count('refreshed'), notDue: count('not-due'), skipped: count('skipped'), failed: count('failed'), results };
  console.log(`Square token refresh done: ${summary.refreshed} refreshed, ${summary.notDue} not due, ${summary.skipped} skipped, ${summary.failed} failed`);
  return summary;
};
