import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({
    clientConfig: {
      WEB_HEADER_COMPANY: 'Liberty Hall',
      THEATER_NAME: 'Liberty Hall Cinema',
      SQUARE_ACCESS_TOKEN: 'super-secret-square-token'
    }
  });
});
after(async () => { await stopTestServer(ctx); });

test('GET /api/client: returns client profile + the user-definable configuration for the client token', async () => {
  const { status, json } = await ctx.request('GET', '/api/client', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.client.clientID, ctx.clientId);
  assert.equal(json.client.configuration.WEB_HEADER_COMPANY, 'Liberty Hall');
});

// Secrets are write-only: the page learns which are saved, never their values.
test('GET /api/client: secret settings are named in savedSecrets, their values are not sent', async () => {
  const { json } = await ctx.request('GET', '/api/client', { token: ctx.clientToken });
  assert.equal(json.client.configuration.SQUARE_ACCESS_TOKEN, undefined);
  assert.ok(json.client.savedSecrets.includes('SQUARE_ACCESS_TOKEN'));
  assert.ok(!JSON.stringify(json).includes('super-secret-square-token'));
});

test('GET /api/client: internal keys like JWT_SECRET are not sent to the browser', async () => {
  const { json } = await ctx.request('GET', '/api/client', { token: ctx.clientToken });
  for (const key of ['JWT_SECRET', 'S3_BUCKET_PREFIX', 'USER_DEFINABLE']) {
    assert.equal(json.client.configuration[key], undefined, `${key} should not be in the response`);
  }
});

// GET /api/client still includes most of the configuration (and which
// secrets are saved) -- requireClientAuth is the gate that keeps a sub-user
// token, even a checkIn-only one, from reading it.
test('GET /api/client: a sub-user token (even checkIn-only) is denied with 403, not given the configuration', async () => {
  const { token } = await ctx.insertUser({
    username: 'doorstaff',
    permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false }
  });
  const { status, json } = await ctx.request('GET', '/api/client', { token });
  assert.equal(status, 403);
  assert.equal(json.success, false);
});

test('GET /api/client: no auth is rejected', async () => {
  const { status } = await ctx.request('GET', '/api/client');
  assert.equal(status, 401);
});

test('GET /api/client/branding: returns only the whitelisted branding fields, not the full configuration', async () => {
  const { status, json } = await ctx.request('GET', '/api/client/branding', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.branding.webHeaderCompany, 'Liberty Hall');
  assert.equal(json.branding.theaterName, 'Liberty Hall Cinema');
  assert.equal(json.branding.SQUARE_ACCESS_TOKEN, undefined);
});

test('GET /api/client/branding: a checkIn-only sub-user can read branding (by design -- it is just the header logo/name)', async () => {
  const { token } = await ctx.insertUser({
    username: 'doorstaff3',
    permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false }
  });
  const { status, json } = await ctx.request('GET', '/api/client/branding', { token });
  assert.equal(status, 200);
  assert.equal(json.branding.webHeaderCompany, 'Liberty Hall');
});

test('PUT /api/client: client token updates contact info and merges configuration', async () => {
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'New Contact', clientEmail: 'new-contact@example.com', configuration: { WEB_HEADER_COMPANY: 'Updated Name' } }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);

  const check = await ctx.request('GET', '/api/client', { token: ctx.clientToken });
  assert.equal(check.json.client.contactName, 'New Contact');
  assert.equal(check.json.client.configuration.WEB_HEADER_COMPANY, 'Updated Name');
  // Unrelated existing config keys survive the merge
  assert.equal((await storedConfig()).SQUARE_ACCESS_TOKEN, 'super-secret-square-token');
});

test('PUT /api/client: missing contactName/clientEmail rejected with 400', async () => {
  const { status } = await ctx.request('PUT', '/api/client', { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
});

test('PUT /api/client: an invalid email is rejected with 400', async () => {
  const { status } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken, body: { contactName: 'X', clientEmail: 'not-an-email' }
  });
  assert.equal(status, 400);
});

// PUT /api/client can overwrite configuration (secrets included) and even
// set a brand new clientSecret (the venue's own login password) --
// requireClientAuth is the gate that keeps a sub-user token, even a
// checkIn-only one, from doing either.
test('PUT /api/client: a sub-user token (even checkIn-only) is denied with 403, cannot overwrite configuration or the login password', async () => {
  const { token } = await ctx.insertUser({
    username: 'doorstaff2',
    permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false }
  });
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token,
    body: { contactName: 'Hijacked', clientEmail: 'hijacked@example.com', clientSecret: 'new-password-123', configuration: { SQUARE_ACCESS_TOKEN: 'attacker-controlled-token' } }
  });
  assert.equal(status, 403);
  assert.equal(json.success, false);
  assert.equal((await storedConfig()).SQUARE_ACCESS_TOKEN, 'super-secret-square-token');
});

// ---- secret settings are write-only ----

test('PUT /api/client: a blank secret keeps the saved one; a new value replaces it', async () => {
  await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'C', clientEmail: 'c@example.com', configuration: { FTP1_PASSWORD: 'ftp-original' } }
  });
  for (const blank of ['', '   ', null]) {
    const { status } = await ctx.request('PUT', '/api/client', {
      token: ctx.clientToken,
      body: { contactName: 'C', clientEmail: 'c@example.com', configuration: { FTP1_PASSWORD: blank, WEB_HEADER_COMPANY: 'Liberty Hall' } }
    });
    assert.equal(status, 200);
    assert.equal((await storedConfig()).FTP1_PASSWORD, 'ftp-original', `blank ${JSON.stringify(blank)} should keep it`);
  }
  await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'C', clientEmail: 'c@example.com', configuration: { FTP1_PASSWORD: 'ftp-new' } }
  });
  assert.equal((await storedConfig()).FTP1_PASSWORD, 'ftp-new');
});

test('PUT /api/client: clearSecrets removes a saved secret; non-secret or unknown keys there are ignored and named', async () => {
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'C', clientEmail: 'c@example.com', configuration: {}, clearSecrets: ['FTP1_PASSWORD', 'WEB_HEADER_COMPANY', 'JWT_SECRET'] }
  });
  assert.equal(status, 200);
  assert.deepEqual(json.ignoredKeys.sort(), ['JWT_SECRET', 'WEB_HEADER_COMPANY']);
  const after = await storedConfig();
  assert.equal(after.FTP1_PASSWORD, '');
  assert.equal(after.WEB_HEADER_COMPANY, 'Liberty Hall');
  assert.ok(after.JWT_SECRET);
  const { json: got } = await ctx.request('GET', '/api/client', { token: ctx.clientToken });
  assert.ok(!got.client.savedSecrets.includes('FTP1_PASSWORD'));
});

// The page's write-only boxes must cover every secret the server withholds,
// or that secret could no longer be edited from Client Settings.
test('client.js SECRET_FIELDS and client.html cover every secret the page edits', async () => {
  const { readFile } = await import('node:fs/promises');
  const js = await readFile(new URL('../src/public/client.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../src/public/client.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const serverKeys = [...app.match(/CLIENT_SETTINGS_SECRET_KEYS = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  const pairs = [...js.match(/const SECRET_FIELDS = \[([\s\S]*?)\];/)[1].matchAll(/\['([\w-]+)', '([A-Z0-9_]+)'\]/g)];
  const pageKeys = pairs.map((m) => m[2]);
  // PASSWORD_RESET_SECRET isn't on the page at all; every other secret is.
  assert.deepEqual(pageKeys.sort(), serverKeys.filter((k) => k !== 'PASSWORD_RESET_SECRET').sort());
  for (const [, id] of pairs) {
    assert.match(html, new RegExp(`id="${id}" data-secret-setting data-lpignore="true"`), `${id} should be marked for password managers to skip`);
  }
  // And no leftover code still loads a secret value into a box.
  for (const key of pageKeys) assert.doesNotMatch(js, new RegExp(`config\\.${key}\\b`), `${key} still read/written directly`);
});

// ---- USER_DEFINABLE enforcement on save ----

async function storedConfig() {
  const { rows } = await ctx.pgClient.query('SELECT configuration FROM "Client" WHERE "clientID" = $1', [ctx.clientId]);
  const config = rows[0].configuration;
  return typeof config === 'string' ? JSON.parse(config) : config;
}

test('PUT /api/client: keys Client Settings may not change are dropped and named, allowed ones still save', async () => {
  const before = await storedConfig();
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: {
      contactName: 'New Contact', clientEmail: 'new-contact@example.com',
      configuration: { JWT_SECRET: 'attacker-chosen', ENV_TYPE: 'prod', USER_DEFINABLE: ['JWT_SECRET'], OWNER_BCC_EMAIL: 'owner@example.com' }
    }
  });
  assert.equal(status, 200);
  assert.deepEqual(json.ignoredKeys.sort(), ['ENV_TYPE', 'JWT_SECRET', 'USER_DEFINABLE']);
  const after = await storedConfig();
  assert.equal(after.JWT_SECRET, before.JWT_SECRET);
  assert.equal(after.ENV_TYPE, before.ENV_TYPE);
  assert.deepEqual(after.USER_DEFINABLE, before.USER_DEFINABLE);
  assert.equal(after.OWNER_BCC_EMAIL, 'owner@example.com');
});

test('PUT /api/client: a venue with an older, shorter stored USER_DEFINABLE list can still save newer keys', async () => {
  await ctx.pgClient.query(
    `UPDATE "Client" SET configuration = (configuration::jsonb || '{"USER_DEFINABLE": ["WEB_HEADER_COMPANY"]}'::jsonb)::json WHERE "clientID" = $1`,
    [ctx.clientId]
  );
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'New Contact', clientEmail: 'new-contact@example.com', configuration: { OMDB_API_KEY: 'new-omdb-key', SENDER_EMAIL: 'tickets@example.com' } }
  });
  assert.equal(status, 200);
  assert.equal(json.ignoredKeys, undefined);
  const after = await storedConfig();
  assert.equal(after.OMDB_API_KEY, 'new-omdb-key');
  assert.equal(after.SENDER_EMAIL, 'tickets@example.com');
});

// Keeps the two lists from drifting: every key onboarding marks
// user-definable (clientSetup-Teardown's default config) must save here.
test('PUT /api/client: every USER_DEFINABLE key from clientSetup-Teardown is accepted', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../clientSetup-Teardown/src/index.js', import.meta.url), 'utf8');
  const list = source.match(/"USER_DEFINABLE":\s*\[([\s\S]*?)\]/)[1];
  const keys = [...list.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50, 'should have found the onboarding list');
  // Keys the save route validates get a well-formed value; the rest just 'x'.
  const ticketTypes = JSON.stringify([{ name: 'Adult', price: '12.50' }]);
  const wellFormed = { SALES_TAX_RATE: '9.3', SCREEN_NUMBERS: { little: '2' }, MOVIE_TICKET_TYPES: ticketTypes, EVENT_TICKET_TYPES: ticketTypes };
  const configuration = Object.fromEntries(keys.map((key) => [key, wellFormed[key] ?? 'x']));
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'New Contact', clientEmail: 'new-contact@example.com', configuration }
  });
  assert.equal(status, 200);
  assert.equal(json.ignoredKeys, undefined, `not accepted: ${json.ignoredKeys}`);
});

// ---- box-office report settings: SALES_TAX_RATE and SCREEN_NUMBERS ----

async function saveReportSettings(configuration) {
  return ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'Test Contact', clientEmail: 'contact@example.com', configuration }
  });
}

test('PUT /api/client: SALES_TAX_RATE and SCREEN_NUMBERS save when well-formed, including blank tax', async () => {
  for (const configuration of [
    { SALES_TAX_RATE: '9.3', SCREEN_NUMBERS: { little: '2', 'Room B': 3 } },
    { SALES_TAX_RATE: '', SCREEN_NUMBERS: {} }
  ]) {
    const { status, json } = await saveReportSettings(configuration);
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(json.ignoredKeys || [], []);
  }
});

test('PUT /api/client: a malformed SALES_TAX_RATE or SCREEN_NUMBERS is rejected with 400', async () => {
  for (const configuration of [
    { SALES_TAX_RATE: '9.3%' },
    { SALES_TAX_RATE: '150' },
    { SALES_TAX_RATE: '-1' },
    { SCREEN_NUMBERS: ['little', '2'] },
    { SCREEN_NUMBERS: { little: 'two' } },
    { SCREEN_NUMBERS: { ' ': '2' } }
  ]) {
    const { status } = await saveReportSettings(configuration);
    assert.equal(status, 400, JSON.stringify(configuration));
  }
});

// ---- Square ticket item settings: ticket types and distributors ----

test('PUT /api/client: ticket types must each have a name and a price', async () => {
  const save = (configuration) => ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'New Contact', clientEmail: 'new-contact@example.com', configuration }
  });
  for (const bad of [
    JSON.stringify([{ name: 'Adult', price: '' }]),
    JSON.stringify([{ name: '', price: '12.50' }]),
    JSON.stringify([{ name: 'Adult', price: '12.505' }]),
    JSON.stringify([{ name: 'Adult', price: '10' }, { name: 'adult', price: '11' }]),
    'not json'
  ]) {
    const { status, json } = await save({ MOVIE_TICKET_TYPES: bad });
    assert.equal(status, 400, bad);
    assert.match(json.message, /Movie ticket types/);
  }
  assert.equal((await save({ EVENT_TICKET_TYPES: '[{"name":"VIP","price":"40"}]', MOVIE_TICKET_TYPES: '', MOVIE_DISTRIBUTOR: 'Janus Films' })).status, 200);
  assert.equal((await save({ EVENT_DISTRIBUTOR: 'x'.repeat(256) })).status, 400);
});
