import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { startTestServer, stopTestServer, secretsMock, sesHandlers } from './helpers/testServer.mjs';
import { sealToken, openToken } from '../src/utils/crypto-utils.mjs';

// Hosted signup (app.mjs HOSTED SIGNUP). Square's token and locations
// endpoints, Secrets Manager, the onboarding Lambda and SES are faked. The
// test venue (TESTCLIENT123) stands in for a venue onboarding created.

const APP_SECRET_ID = 'indieTix/square/app/test';
const APP_CLIENT_SECRET = 'test-app-client-secret';
const SITE = 'https://site.example.com';
const KEY = crypto.createHash('sha256').update(`indietix-hosted-signup:${APP_CLIENT_SECRET}`).digest();
const ENV = {
  SQUARE_APP_ID: 'sq0idp-test-app',
  SQUARE_APP_SECRET_ID: APP_SECRET_ID,
  SQUARE_OAUTH_REDIRECT_URL: 'https://api.example.com/square/oauth/callback',
  HOSTED_SIGNUP_ENABLED: 'true',
  CLIENT_SETUP_FUNCTION: 'test-client-setup-teardown',
  HOSTED_STATIC_SITE_URL: `${SITE}/`,
  HOSTED_SENDER_EMAIL: 'hello@indietix.example',
  VENUE_BUCKET_PREFIX: 'indietix-test-',
  HOSTED_TERMS_URL: 'https://indietix.example/terms'
};

const lambdaMock = mockClient(LambdaClient);
let ctx, harnessFetch, merchantId, emails;

function signupEnv(on) {
  for (const [key, value] of Object.entries(ENV)) {
    if (on) process.env[key] = value;
    else delete process.env[key];
  }
}

before(async () => {
  signupEnv(true);
  ctx = await startTestServer({ clientConfig: { SIGNUP_SOURCE: 'hosted', SENDER_EMAIL: 'hello@indietix.example' } });
  harnessFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr === 'https://connect.squareup.com/oauth2/token') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: '2026-12-02T12:00:00Z', merchant_id: merchantId }) };
    }
    if (urlStr === 'https://connect.squareup.com/v2/locations') {
      return { ok: true, status: 200, json: async () => ({ locations: [{ id: 'LOC1', status: 'ACTIVE' }] }) };
    }
    return harnessFetch(url, opts);
  };
  secretsMock.on(GetSecretValueCommand, { SecretId: APP_SECRET_ID }).resolves({ SecretString: JSON.stringify({
    client_secret: APP_CLIENT_SECRET, webhook_signature_key: 'app-sub-key', webhook_url: 'https://hooks.example.com/webhook/square'
  }) });
});

after(async () => {
  globalThis.fetch = harnessFetch;
  signupEnv(false);
  await stopTestServer(ctx);
});

beforeEach(() => {
  signupEnv(true);
  merchantId = 'NEWVENUE1';
  emails = [];
  sesHandlers.sendRawEmail = async (params) => {
    // Undo quoted-printable soft line breaks and =3D, so assertions read plainly.
    emails.push(Buffer.from(params.RawMessage.Data).toString('utf8').replace(/=\r\n/g, '').replace(/=3D/g, '='));
    return { MessageId: 'm' };
  };
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
  secretsMock.on(PutSecretValueCommand).rejects(Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' }));
  secretsMock.on(CreateSecretCommand).resolves({});
});

const goodSignup = { venueName: 'The Bijou', contactName: 'Pat Doe', contactEmail: 'pat@bijou.example', acceptTerms: true };
const signupState = (extra = {}) => sealToken({ p: 'signup', venueName: 'The Bijou', contactName: 'Pat Doe', contactEmail: 'pat@bijou.example', termsAcceptedAt: 't', ...extra }, KEY, 60000);

async function callback(query) {
  const res = await harnessFetch(`${ctx.baseUrl}/square/oauth/callback?${new URLSearchParams(query)}`, { redirect: 'manual' });
  return { status: res.status, location: new URL(res.headers.get('location') || 'http://none/') };
}
async function setFlags(sql) {
  await ctx.pgClient.query(`UPDATE "Client" SET configuration = (configuration::jsonb ${sql})::json WHERE "clientID" = $1`, [ctx.clientId]);
}

test('sealed tokens: purpose-bound, tamper-proof, expiring', () => {
  const token = sealToken({ p: 'a', x: 1 }, KEY, 60000);
  assert.equal(openToken(token, KEY, 'a').x, 1);
  assert.equal(openToken(token, KEY, 'b'), null);
  assert.equal(openToken(token, crypto.randomBytes(32), 'a'), null);
  assert.equal(openToken(token.slice(0, -2) + 'AA', KEY, 'a'), null);
  assert.equal(openToken(sealToken({ p: 'a' }, KEY, -1), KEY, 'a'), null);
  assert.equal(openToken('junk', KEY, 'a'), null);
});

test('config: open only when hosted signup is fully configured', async () => {
  let { json } = await ctx.request('GET', '/api/public/signup/config');
  assert.equal(json.enabled, true);
  assert.equal(json.termsUrl, 'https://indietix.example/terms');
  delete process.env.HOSTED_SIGNUP_ENABLED;
  ({ json } = await ctx.request('GET', '/api/public/signup/config'));
  assert.equal(json.enabled, false);
  const { status } = await ctx.request('POST', '/api/public/signup/start', { body: goodSignup });
  assert.equal(status, 404);
});

test('start: validates the form', async () => {
  for (const body of [
    { ...goodSignup, venueName: 'x' },
    { ...goodSignup, contactName: '' },
    { ...goodSignup, contactEmail: 'not-an-email' },
    { ...goodSignup, acceptTerms: false }
  ]) {
    const { status } = await ctx.request('POST', '/api/public/signup/start', { body, headers: { 'x-forwarded-for': '10.0.0.1' } });
    assert.equal(status, 400, JSON.stringify(body));
  }
});

test("start: returns Square's sign-in URL; the details travel only inside the sealed state", async () => {
  const { status, json } = await ctx.request('POST', '/api/public/signup/start', { body: goodSignup, headers: { 'x-forwarded-for': '10.0.0.2' } });
  assert.equal(status, 200);
  const url = new URL(json.url);
  assert.equal(url.searchParams.get('client_id'), 'sq0idp-test-app');
  assert.ok(!json.url.includes('bijou'), 'no readable contact details in the URL');
  const state = openToken(url.searchParams.get('state'), KEY, 'signup');
  assert.equal(state.venueName, 'The Bijou');
  assert.equal(state.contactEmail, 'pat@bijou.example');
});

test('start: rate limited per address', async () => {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await ctx.request('POST', '/api/public/signup/start', { body: goodSignup, headers: { 'x-forwarded-for': '10.9.9.9' } });
  }
  assert.equal(last.status, 429);
});

test('callback: a new Square account starts onboarding in the background with OAuth details, then goes to the status page', async () => {
  const res = await callback({ code: 'auth-code', state: signupState() });
  assert.equal(res.status, 302);
  assert.equal(res.location.origin + res.location.pathname, `${SITE}/signup.html`);
  assert.equal(openToken(res.location.searchParams.get('status'), KEY, 'signup-status').clientId, 'NEWVENUE1');

  const invoke = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
  assert.equal(invoke.FunctionName, 'test-client-setup-teardown');
  assert.equal(invoke.InvocationType, 'Event');
  const payload = JSON.parse(Buffer.from(invoke.Payload).toString('utf8'));
  assert.equal(payload.username, 'NEWVENUE1');
  assert.equal(payload.theater_name, 'The Bijou');
  assert.equal(payload.clientEmail, 'pat@bijou.example');
  assert.equal(payload.square_access_token, 'new-access');
  assert.equal(payload.square_signature_key, 'app-sub-key');
  assert.equal(payload.square_webhook_url, 'https://hooks.example.com/webhook/square');
  assert.equal(payload.square_location_id, 'LOC1');
  assert.equal(payload.s3_bucket_prefix, 'indietix-test-');
  assert.deepEqual(payload.square_oauth, { merchant_id: 'NEWVENUE1', expires_at: '2026-12-02T12:00:00Z' });
  assert.equal(payload.settings.STATIC_WEBSITE_URL, SITE);
  assert.ok(payload.clientSecret.length >= 24);
  assert.ok(!JSON.stringify(payload).includes('new-refresh'), 'the refresh token is not in the payload');

  const created = secretsMock.commandCalls(CreateSecretCommand).at(-1).args[0].input;
  assert.equal(created.Name, 'indieTix/square/clients/NEWVENUE1');
});

test("callback: a Square account that already has a venue isn't onboarded again, and gets the password link again if it was never used", async () => {
  merchantId = ctx.clientId;
  await setFlags(`- 'SIGNUP_PASSWORD_SET_AT'`);
  const res = await callback({ code: 'auth-code', state: signupState() });
  assert.equal(res.location.searchParams.get('result'), 'exists');
  assert.equal(lambdaMock.commandCalls(InvokeCommand).length, 0);
  assert.equal(emails.length, 1);
  assert.match(emails[0], /signup\.html\?set=/);

  await setFlags(`|| '{"SIGNUP_PASSWORD_SET_AT": "2026-11-01"}'::jsonb`);
  await callback({ code: 'auth-code', state: signupState() });
  assert.equal(emails.length, 1, 'no new link once the password was set');
});

test('callback: an expired or forged signup, or a declined sign-in, creates nothing', async () => {
  for (const [query, result] of [
    [{ code: 'c', state: sealToken({ p: 'signup' }, KEY, -1) }, 'expired'],
    [{ code: 'c', state: sealToken({ p: 'signup' }, crypto.randomBytes(32), 60000) }, 'expired'],
    [{ error: 'access_denied', state: signupState() }, 'denied']
  ]) {
    const res = await callback(query);
    assert.equal(res.location.searchParams.get('result'), result);
  }
  assert.equal(lambdaMock.commandCalls(InvokeCommand).length, 0);
});

test('status: not ready until the venue exists; then the welcome email goes out exactly once', async () => {
  let { json } = await ctx.request('GET', `/api/public/signup/status?token=${sealToken({ p: 'signup-status', clientId: 'NOTYETCREATED' }, KEY, 60000)}`);
  assert.deepEqual(json, { success: true, ready: false });

  await setFlags(`- 'SIGNUP_WELCOME_SENT_AT'`);
  const token = sealToken({ p: 'signup-status', clientId: ctx.clientId }, KEY, 60000);
  ({ json } = await ctx.request('GET', `/api/public/signup/status?token=${token}`));
  assert.equal(json.ready, true);
  assert.equal(emails.length, 1);
  assert.match(emails[0], /Your IndieTix box office is ready/);
  assert.match(emails[0], new RegExp(`login\\.html\\?client=${ctx.clientId}`));
  await ctx.request('GET', `/api/public/signup/status?token=${token}`);
  assert.equal(emails.length, 1);

  const bad = await ctx.request('GET', `/api/public/signup/status?token=${sealToken({ p: 'set-password', clientId: ctx.clientId }, KEY, 60000)}`);
  assert.equal(bad.status, 400);
});

test('set-password: sets the main login once; it then works for logging in', async () => {
  await setFlags(`- 'SIGNUP_PASSWORD_SET_AT'`);
  const token = sealToken({ p: 'set-password', clientId: ctx.clientId }, KEY, 60000);
  let res = await ctx.request('POST', '/api/public/signup/set-password', { body: { token, password: 'short' } });
  assert.equal(res.status, 400);
  res = await ctx.request('POST', '/api/public/signup/set-password', { body: { token: 'junk', password: 'long-enough-password' } });
  assert.equal(res.status, 400);

  res = await ctx.request('POST', '/api/public/signup/set-password', { body: { token, password: 'my-new-venue-password' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.loginUrl, `${SITE}/login.html?client=${ctx.clientId}`);
  const login = await ctx.request('POST', '/api/login', { body: { clientId: ctx.clientId, username: ctx.clientId, password: 'my-new-venue-password' } });
  assert.equal(login.status, 200);
  assert.ok(login.json.token);

  res = await ctx.request('POST', '/api/public/signup/set-password', { body: { token, password: 'another-password-123' } });
  assert.equal(res.status, 409);
});
