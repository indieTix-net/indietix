import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { startTestServer, stopTestServer, secretsMock, JWT_SECRET } from './helpers/testServer.mjs';

// Connect Square (OAuth). Square's token and locations endpoints are faked
// on top of the harness's fetch patch, and the app secret and refresh-token
// secret on top of its Secrets Manager mock, so nothing leaves the machine.

const APP_SECRET_ID = 'indieTix/square/app/test';
const REDIRECT_URL = 'https://api.example.com/square/oauth/callback';

let ctx;
let harnessFetch;
let squareCalls;
let tokenAnswer;
let locationsAnswer;

function oauthEnv(on) {
  for (const [key, value] of Object.entries({
    SQUARE_APP_ID: 'sq0idp-test-app',
    SQUARE_APP_SECRET_ID: APP_SECRET_ID,
    SQUARE_OAUTH_REDIRECT_URL: REDIRECT_URL
  })) {
    if (on) process.env[key] = value;
    else delete process.env[key];
  }
}

before(async () => {
  ctx = await startTestServer({ clientConfig: { SQUARE_ACCESS_TOKEN: 'personal-token' } });
  harnessFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr === 'https://connect.squareup.com/oauth2/token') {
      squareCalls.push({ url: urlStr, body: JSON.parse(opts.body) });
      return tokenAnswer();
    }
    if (urlStr === 'https://connect.squareup.com/v2/locations') {
      squareCalls.push({ url: urlStr, auth: opts.headers.Authorization });
      return locationsAnswer();
    }
    return harnessFetch(url, opts);
  };
  secretsMock.on(GetSecretValueCommand, { SecretId: APP_SECRET_ID })
    .resolves({ SecretString: JSON.stringify({ client_secret: 'test-app-client-secret' }) });
});

after(async () => {
  globalThis.fetch = harnessFetch;
  oauthEnv(false);
  await stopTestServer(ctx);
});

beforeEach(async () => {
  oauthEnv(true);
  squareCalls = [];
  tokenAnswer = async () => ({
    ok: true, status: 200,
    json: async () => ({
      access_token: 'oauth-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: '2026-12-02T15:00:00Z',
      merchant_id: ctx.clientId
    })
  });
  locationsAnswer = async () => ({
    ok: true, status: 200,
    json: async () => ({ locations: [{ id: 'LOC1', status: 'ACTIVE' }, { id: 'LOC_OLD', status: 'INACTIVE' }] })
  });
  secretsMock.on(PutSecretValueCommand).rejects(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));
  secretsMock.on(CreateSecretCommand).resolves({});
  secretsMock.resetHistory();
  await ctx.pgClient.query(
    `UPDATE "Client" SET configuration = (configuration::jsonb - 'SQUARE_AUTH_MODE' - 'SQUARE_MERCHANT_ID' - 'SQUARE_TOKEN_EXPIRES_AT' - 'SQUARE_LOCATION_ID'
       || '{"SQUARE_ACCESS_TOKEN": "personal-token"}'::jsonb)::json WHERE "clientID" = $1`,
    [ctx.clientId]
  );
});

async function storedConfig() {
  const { rows } = await ctx.pgClient.query('SELECT configuration FROM "Client" WHERE "clientID" = $1', [ctx.clientId]);
  const config = rows[0].configuration;
  return typeof config === 'string' ? JSON.parse(config) : config;
}

function stateFor({ clientId = ctx.clientId, secret = JWT_SECRET, expiresIn = '10m', purpose = 'square-oauth' } = {}) {
  return jwt.sign({ purpose, clientId, nonce: 'n' }, secret, { expiresIn });
}

// The callback redirects to the venue's static site; don't follow it.
async function callback(query) {
  const res = await harnessFetch(`${ctx.baseUrl}/square/oauth/callback?${new URLSearchParams(query)}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

test('status: unavailable without a Square app on this deployment; personal mode by default', async () => {
  oauthEnv(false);
  let { json } = await ctx.request('GET', '/api/square/oauth/status', { token: ctx.clientToken });
  assert.equal(json.available, false);
  oauthEnv(true);
  ({ json } = await ctx.request('GET', '/api/square/oauth/status', { token: ctx.clientToken }));
  assert.equal(json.available, true);
  assert.equal(json.mode, 'personal');
  assert.equal(json.sandbox, false);
});

test('start: 404 without a Square app on this deployment', async () => {
  oauthEnv(false);
  const { status } = await ctx.request('GET', '/api/square/oauth/start', { token: ctx.clientToken });
  assert.equal(status, 404);
});

test("start: returns Square's sign-in URL with the app, permissions, redirect and a signed 10-minute state", async () => {
  const { status, json } = await ctx.request('GET', '/api/square/oauth/start', { token: ctx.clientToken });
  assert.equal(status, 200);
  const url = new URL(json.url);
  assert.equal(url.origin + url.pathname, 'https://connect.squareup.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'sq0idp-test-app');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URL);
  assert.equal(url.searchParams.get('session'), 'false');
  assert.ok(url.searchParams.get('scope').split(' ').includes('ITEMS_WRITE'));
  const state = jwt.verify(url.searchParams.get('state'), JWT_SECRET);
  assert.equal(state.purpose, 'square-oauth');
  assert.equal(state.clientId, ctx.clientId);
  assert.ok(state.exp - state.iat <= 600);
});

test('start and status: client login only', async () => {
  const { token } = await ctx.insertUser({ username: 'oauth-staff', permissions: { view: true, edit: true, checkIn: true, marketing: true, admin: true } });
  for (const path of ['/api/square/oauth/start', '/api/square/oauth/status']) {
    const { status } = await ctx.request('GET', path, { token });
    assert.equal(status, 403, path);
  }
});

test('callback: swaps the code, stores the tokens (refresh token only in Secrets Manager), picks the one active location', async () => {
  const res = await callback({ code: 'auth-code', state: stateFor() });
  assert.equal(res.status, 302);
  assert.equal(res.location, 'https://example.com/client.html?square=connected');

  const exchange = squareCalls.find(c => c.url.endsWith('/oauth2/token')).body;
  assert.deepEqual(exchange, {
    client_id: 'sq0idp-test-app', client_secret: 'test-app-client-secret', code: 'auth-code',
    grant_type: 'authorization_code', redirect_uri: REDIRECT_URL
  });
  assert.equal(squareCalls.find(c => c.url.endsWith('/v2/locations')).auth, 'Bearer oauth-access-token');

  const config = await storedConfig();
  assert.equal(config.SQUARE_ACCESS_TOKEN, 'oauth-access-token');
  assert.equal(config.SQUARE_AUTH_MODE, 'oauth');
  assert.equal(config.SQUARE_MERCHANT_ID, ctx.clientId);
  assert.equal(config.SQUARE_TOKEN_EXPIRES_AT, '2026-12-02T15:00:00Z');
  assert.equal(config.SQUARE_LOCATION_ID, 'LOC1');
  assert.ok(!JSON.stringify(config).includes('oauth-refresh-token'), 'refresh token must not be in the database');

  const created = secretsMock.commandCalls(CreateSecretCommand).at(-1).args[0].input;
  assert.equal(created.Name, `indieTix/square/clients/${ctx.clientId}`);
  assert.deepEqual(JSON.parse(created.SecretString), { refresh_token: 'oauth-refresh-token' });

  const { json } = await ctx.request('GET', '/api/square/oauth/status', { token: ctx.clientToken });
  assert.equal(json.mode, 'oauth');
  assert.equal(json.merchantId, ctx.clientId);
});

test("callback: a different Square account is refused and nothing is stored", async () => {
  tokenAnswer = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'r', merchant_id: 'SOMEONEELSE' }) });
  const res = await callback({ code: 'auth-code', state: stateFor() });
  assert.equal(res.location, 'https://example.com/client.html?square=wrong-account');
  const config = await storedConfig();
  assert.equal(config.SQUARE_ACCESS_TOKEN, 'personal-token');
  assert.equal(config.SQUARE_AUTH_MODE, undefined);
  assert.equal(secretsMock.commandCalls(CreateSecretCommand).length, 0);
});

test('callback: a forged, expired or wrong-purpose state is refused before Square is called', async () => {
  for (const state of [
    stateFor({ secret: 'not-the-venue-secret' }),
    stateFor({ expiresIn: '-1m' }),
    stateFor({ purpose: 'password-reset' })
  ]) {
    const res = await callback({ code: 'auth-code', state });
    assert.equal(res.location, 'https://example.com/client.html?square=expired');
  }
  assert.equal(squareCalls.length, 0);
  assert.equal((await storedConfig()).SQUARE_ACCESS_TOKEN, 'personal-token');
});

test('callback: no state, or an unknown venue, gets a plain error page (no venue to return to)', async () => {
  for (const query of [{ code: 'x' }, { code: 'x', state: stateFor({ clientId: 'NOSUCHVENUE' }) }, { code: 'x', state: stateFor({ clientId: '../etc' }) }]) {
    const res = await callback(query);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.match(res.text, /Square could not be connected/);
  }
});

test('callback: the seller declining access returns "denied"', async () => {
  const res = await callback({ error: 'access_denied', state: stateFor() });
  assert.equal(res.location, 'https://example.com/client.html?square=denied');
  assert.equal(squareCalls.length, 0);
});

test('callback: a failed token exchange returns "failed" and changes nothing', async () => {
  tokenAnswer = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ code: 'UNAUTHORIZED' }] }) });
  const res = await callback({ code: 'bad-code', state: stateFor() });
  assert.equal(res.location, 'https://example.com/client.html?square=failed');
  assert.equal((await storedConfig()).SQUARE_ACCESS_TOKEN, 'personal-token');
});

test('callback: an existing location is kept, and an existing refresh-token secret is updated in place', async () => {
  await ctx.pgClient.query(
    `UPDATE "Client" SET configuration = (configuration::jsonb || '{"SQUARE_LOCATION_ID": "LOC_CHOSEN"}'::jsonb)::json WHERE "clientID" = $1`,
    [ctx.clientId]
  );
  secretsMock.on(PutSecretValueCommand).resolves({});
  const res = await callback({ code: 'auth-code', state: stateFor() });
  assert.equal(res.location, 'https://example.com/client.html?square=connected');
  assert.equal((await storedConfig()).SQUARE_LOCATION_ID, 'LOC_CHOSEN');
  assert.ok(!squareCalls.some(c => c.url.endsWith('/v2/locations')));
  assert.equal(secretsMock.commandCalls(CreateSecretCommand).length, 0);
});

test('Client Settings: typing a personal token switches the venue back to personal mode', async () => {
  await callback({ code: 'auth-code', state: stateFor() });
  assert.equal((await storedConfig()).SQUARE_AUTH_MODE, 'oauth');
  const { status } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'C', clientEmail: 'c@example.com', configuration: { SQUARE_ACCESS_TOKEN: 'new-personal-token' } }
  });
  assert.equal(status, 200);
  const config = await storedConfig();
  assert.equal(config.SQUARE_ACCESS_TOKEN, 'new-personal-token');
  assert.equal(config.SQUARE_AUTH_MODE, 'personal');
});
