import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, ListSecretsCommand
} from '@aws-sdk/client-secrets-manager';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import {
  REFRESH_WHEN_DAYS_LEFT, isRefreshDue, listOAuthVenues, refreshVenue, buildRefreshAlert, sendAlert, handler
} from '../src/index.mjs';

// A real venue database (test-db-harness Postgres, real schema); Square's
// token endpoint, Secrets Manager and SES are faked. Nothing leaves the
// machine.

const CLIENT_ID = 'REFRESHVENUE1';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-02T12:00:00Z');

const secretsMock = mockClient(SecretsManagerClient);
const sesMock = mockClient(SESClient);
const secrets = new SecretsManagerClient({});

let dbConfig, containerName, db;
let squareCalls, squareAnswer;

async function fakeFetch(url, opts) {
  squareCalls.push({ url: String(url), body: JSON.parse(opts.body) });
  return squareAnswer();
}

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: CLIENT_ID }));
  await createDatabaseObjects(dbConfig, CLIENT_ID, 1, 'Test Theatre', 'TT');
  db = new pg.Client(dbConfig);
  await db.connect();
  await db.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ($1, 'x', 'Contact', 'owner@example.com', '{}')`,
    [CLIENT_ID]
  );
});

after(async () => {
  await db.end();
  await teardownTestDatabase(containerName);
});

async function setConfig(config) {
  await db.query(`UPDATE "Client" SET configuration = $1 WHERE "clientID" = $2`, [JSON.stringify(config), CLIENT_ID]);
}
async function storedConfig() {
  const { rows } = await db.query('SELECT configuration FROM "Client" WHERE "clientID" = $1', [CLIENT_ID]);
  return typeof rows[0].configuration === 'string' ? JSON.parse(rows[0].configuration) : rows[0].configuration;
}

const oauthVenue = (daysLeft) => ({
  SQUARE_AUTH_MODE: 'oauth',
  SQUARE_ACCESS_TOKEN: 'old-access-token',
  SQUARE_TOKEN_EXPIRES_AT: new Date(NOW + daysLeft * DAY).toISOString(),
  SENDER_EMAIL: 'tickets@example.com',
  WEB_HEADER_COMPANY: 'Test Cinema'
});

beforeEach(() => {
  squareCalls = [];
  squareAnswer = async () => ({
    ok: true, status: 200,
    json: async () => ({ access_token: 'new-access-token', refresh_token: 'refresh-1', expires_at: '2026-12-02T12:00:00Z' })
  });
  secretsMock.reset();
  secretsMock.on(GetSecretValueCommand, { SecretId: `indieTix/square/clients/${CLIENT_ID}` })
    .resolves({ SecretString: JSON.stringify({ refresh_token: 'refresh-1' }) });
  secretsMock.on(PutSecretValueCommand).resolves({});
  sesMock.reset();
  sesMock.on(SendRawEmailCommand).resolves({ MessageId: 'm1' });
});

const run = () => refreshVenue(CLIENT_ID, { secrets, db, appId: 'app-id', appSecret: 'app-secret', now: NOW, fetchFn: fakeFetch });

test('isRefreshDue: refresh once fewer than REFRESH_WHEN_DAYS_LEFT days remain, or when the expiry is unknown', () => {
  assert.equal(REFRESH_WHEN_DAYS_LEFT, 23);
  assert.equal(isRefreshDue(new Date(NOW + 29 * DAY).toISOString(), NOW), false);
  assert.equal(isRefreshDue(new Date(NOW + 22 * DAY).toISOString(), NOW), true);
  assert.equal(isRefreshDue(new Date(NOW - DAY).toISOString(), NOW), true);
  assert.equal(isRefreshDue(null, NOW), true);
  assert.equal(isRefreshDue('not a date', NOW), true);
});

test('listOAuthVenues: venues with a refresh-token secret, across pages, ignoring odd names', async () => {
  secretsMock.on(ListSecretsCommand)
    .resolvesOnce({ SecretList: [{ Name: 'indieTix/square/clients/BBB2' }, { Name: 'indieTix/square/clients/../x' }], NextToken: 't' })
    .resolvesOnce({ SecretList: [{ Name: 'indieTix/square/clients/AAA1' }] });
  assert.deepEqual(await listOAuthVenues(secrets), ['AAA1', 'BBB2']);
  assert.deepEqual(secretsMock.commandCalls(ListSecretsCommand)[0].args[0].input.Filters, [{ Key: 'name', Values: ['indieTix/square/clients/'] }]);
});

test('refresh: a due token is renewed and saved to SQUARE_ACCESS_TOKEN; same refresh token, secret left alone', async () => {
  await setConfig(oauthVenue(20));
  const result = await run();
  assert.equal(result.status, 'refreshed');
  assert.deepEqual(squareCalls[0], {
    url: 'https://connect.squareup.com/oauth2/token',
    body: { client_id: 'app-id', client_secret: 'app-secret', grant_type: 'refresh_token', refresh_token: 'refresh-1' }
  });
  const config = await storedConfig();
  assert.equal(config.SQUARE_ACCESS_TOKEN, 'new-access-token');
  assert.equal(config.SQUARE_TOKEN_EXPIRES_AT, '2026-12-02T12:00:00Z');
  assert.equal(config.SENDER_EMAIL, 'tickets@example.com', 'other settings kept');
  assert.equal(secretsMock.commandCalls(PutSecretValueCommand).length, 0);
});

test('refresh: a new refresh token from Square replaces the stored one', async () => {
  await setConfig(oauthVenue(20));
  squareAnswer = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a2', refresh_token: 'refresh-2', expires_at: '2026-12-02T12:00:00Z' }) });
  assert.equal((await run()).status, 'refreshed');
  const put = secretsMock.commandCalls(PutSecretValueCommand)[0].args[0].input;
  assert.equal(put.SecretId, `indieTix/square/clients/${CLIENT_ID}`);
  assert.deepEqual(JSON.parse(put.SecretString), { refresh_token: 'refresh-2' });
});

test('refresh: not due yet, or a personal-token venue, means no call to Square', async () => {
  await setConfig(oauthVenue(28));
  assert.equal((await run()).status, 'not-due');
  await setConfig({ SQUARE_ACCESS_TOKEN: 'personal' });
  assert.equal((await run()).status, 'skipped');
  assert.equal(squareCalls.length, 0);
  assert.equal((await storedConfig()).SQUARE_ACCESS_TOKEN, 'personal');
});

test('refresh: Square refusing (revoked access) fails without touching the token', async () => {
  await setConfig(oauthVenue(2));
  squareAnswer = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ code: 'UNAUTHORIZED' }] }) });
  const result = await run();
  assert.equal(result.status, 'failed');
  assert.equal(result.revoked, true);
  assert.match(result.error, /HTTP 401, UNAUTHORIZED/);
  const config = await storedConfig();
  assert.equal(config.SQUARE_ACCESS_TOKEN, 'old-access-token');
  // Flagged, so tomorrow's run skips it instead of emailing again.
  assert.equal(config.SQUARE_OAUTH_REVOKED_AT, new Date(NOW).toISOString());
  squareCalls = [];
  const next = await run();
  assert.equal(next.status, 'skipped');
  assert.match(next.reason, /Reconnect Square/);
  assert.equal(squareCalls.length, 0);
});

test('refresh: a network error or a missing refresh-token secret is a failure, never a throw', async () => {
  await setConfig(oauthVenue(5));
  squareAnswer = async () => { throw new Error('ECONNRESET'); };
  let result = await run();
  assert.equal(result.status, 'failed');
  assert.equal(result.revoked, undefined);
  assert.match(result.error, /ECONNRESET/);

  secretsMock.on(GetSecretValueCommand, { SecretId: `indieTix/square/clients/${CLIENT_ID}` }).rejects(new Error('ResourceNotFoundException'));
  result = await run();
  assert.equal(result.status, 'failed');
});

test('alerts: a failure emails the venue contact, OWNER_BCC_EMAIL and the operator, from SENDER_EMAIL', async () => {
  await setConfig({ ...oauthVenue(2), OWNER_BCC_EMAIL: 'owner@example.com' });
  squareAnswer = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ code: 'UNAUTHORIZED' }] }) });
  const alert = buildRefreshAlert(await run(), 'ops@indietix.example');
  assert.equal(alert.from, 'tickets@example.com');
  assert.deepEqual(alert.to, ['owner@example.com', 'ops@indietix.example']);
  assert.match(alert.subject, /Square connection needs attention for Test Cinema/);
  assert.match(alert.text, /Reconnect Square/);
  assert.match(alert.text, /access .* was removed/);
  assert.doesNotMatch(alert.text, /old-access-token|refresh-1/);

  const sent = await sendAlert(alert, new SESClient({}));
  assert.deepEqual(sent, { clientId: CLIENT_ID, sent: true });
  assert.equal(sesMock.commandCalls(SendRawEmailCommand)[0].args[0].input.Source, 'tickets@example.com');
});

test('alerts: nothing for a success; nothing without a sender; an SES error is returned, not thrown', async () => {
  assert.equal(buildRefreshAlert({ status: 'refreshed' }), null);
  assert.equal(buildRefreshAlert({ status: 'failed', clientId: 'X', venue: { config: {}, contactEmail: 'a@b.c' } }), null);
  sesMock.on(SendRawEmailCommand).rejects(new Error('not verified'));
  const sent = await sendAlert({ clientId: 'X', from: 'a@b.c', to: ['d@e.f'], subject: 's', text: 't' }, new SESClient({}));
  assert.equal(sent.sent, false);
});

test('handler: without a Square app configured it does nothing', async () => {
  delete process.env.SQUARE_APP_ID;
  delete process.env.SQUARE_APP_SECRET_ID;
  const summary = await handler();
  assert.equal(summary.refreshed, 0);
  assert.equal(secretsMock.commandCalls(ListSecretsCommand).length, 0);
});

test('handler: refreshes each Connect Square venue end to end and summarizes', async () => {
  await setConfig(oauthVenue(10));
  process.env.SQUARE_APP_ID = 'app-id';
  process.env.SQUARE_APP_SECRET_ID = 'indieTix/square/app/test';
  secretsMock.on(GetSecretValueCommand, { SecretId: 'indieTix/square/app/test' })
    .resolves({ SecretString: JSON.stringify({ client_secret: 'app-secret' }) });
  secretsMock.on(GetSecretValueCommand, { SecretId: `indieTix/rds/clients/${CLIENT_ID}/credentials` })
    .resolves({ SecretString: JSON.stringify({ host: dbConfig.host, port: String(dbConfig.port), username: dbConfig.user, password: dbConfig.password, ssl: 'false' }) });
  secretsMock.on(ListSecretsCommand).resolves({ SecretList: [{ Name: `indieTix/square/clients/${CLIENT_ID}` }] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const summary = await handler();
    assert.equal(summary.refreshed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.results[0].venue, undefined, 'venue settings are not returned');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SQUARE_APP_ID;
    delete process.env.SQUARE_APP_SECRET_ID;
  }
  assert.equal((await storedConfig()).SQUARE_ACCESS_TOKEN, 'new-access-token');
});
