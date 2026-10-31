import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { WEB_HEADER_COMPANY: 'Liberty Hall' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "MarketingEmailContact"`);
});

// ---- POST /api/public/email-signup ----

test('POST /api/public/email-signup: a new email is added as active', async () => {
  const { status, json } = await ctx.request('POST', '/api/public/email-signup', {
    body: { client: ctx.clientId, email: 'New.Fan@Example.com' }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.venueName, 'Liberty Hall');

  const row = await ctx.pgClient.query(`SELECT * FROM "MarketingEmailContact" WHERE "Email" = 'new.fan@example.com'`);
  assert.equal(row.rows.length, 1, 'email should be normalized to lowercase/trimmed');
  assert.equal(row.rows[0].Status, 'active');
});

test('POST /api/public/email-signup: signing up again is idempotent, no duplicate row', async () => {
  await ctx.request('POST', '/api/public/email-signup', { body: { client: ctx.clientId, email: 'again@example.com' } });
  const { status } = await ctx.request('POST', '/api/public/email-signup', { body: { client: ctx.clientId, email: 'again@example.com' } });
  assert.equal(status, 200);
  const rows = await ctx.pgClient.query(`SELECT * FROM "MarketingEmailContact" WHERE "Email" = 'again@example.com'`);
  assert.equal(rows.rows.length, 1);
});

test('POST /api/public/email-signup: re-signing up after unsubscribing re-activates the existing row', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('returning@example.com', 'unsubscribed', 'tok-returning')`);
  const { status } = await ctx.request('POST', '/api/public/email-signup', { body: { client: ctx.clientId, email: 'returning@example.com' } });
  assert.equal(status, 200);
  const row = await ctx.pgClient.query(`SELECT * FROM "MarketingEmailContact" WHERE "Email" = 'returning@example.com'`);
  assert.equal(row.rows[0].Status, 'active');
  assert.equal(row.rows[0].UnsubscribeToken, 'tok-returning', 'resubscribe reuses the existing row/token, does not re-create it');
});

test('POST /api/public/email-signup: an invalid email is rejected with 400', async () => {
  const { status, json } = await ctx.request('POST', '/api/public/email-signup', { body: { client: ctx.clientId, email: 'not-an-email' } });
  assert.equal(status, 400);
  assert.equal(json.success, false);
});

test('POST /api/public/email-signup: a malformed client id is rejected before any DB connection', async () => {
  const { status } = await ctx.request('POST', '/api/public/email-signup', { body: { client: 'bad client!', email: 'x@example.com' } });
  assert.equal(status, 400);
});

test('POST /api/public/email-signup: an unknown client fails cleanly (bad DB credentials -> 500, not a crash)', async () => {
  const { status } = await ctx.request('POST', '/api/public/email-signup', { body: { client: 'NOSUCHCLIENT999', email: 'x@example.com' } });
  assert.equal(status, 500);
});

// ---- GET /api/public/email-unsubscribe ----

test('GET /api/public/email-unsubscribe: a valid token unsubscribes the contact', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('unsub1@example.com', 'active', 'tok-unsub1')`);
  const { status, json } = await ctx.request('GET', `/api/public/email-unsubscribe?token=tok-unsub1&client=${ctx.clientId}`);
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const row = await ctx.pgClient.query(`SELECT "Status" FROM "MarketingEmailContact" WHERE "Email" = 'unsub1@example.com'`);
  assert.equal(row.rows[0].Status, 'unsubscribed');
});

test('GET /api/public/email-unsubscribe: re-clicking the same link is idempotent (CAN-SPAM one-click semantics)', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('unsub2@example.com', 'active', 'tok-unsub2')`);
  const first = await ctx.request('GET', `/api/public/email-unsubscribe?token=tok-unsub2&client=${ctx.clientId}`);
  assert.equal(first.status, 200);
  const second = await ctx.request('GET', `/api/public/email-unsubscribe?token=tok-unsub2&client=${ctx.clientId}`);
  assert.equal(second.status, 200);
});

test('GET /api/public/email-unsubscribe: an unknown token returns 404', async () => {
  const { status, json } = await ctx.request('GET', `/api/public/email-unsubscribe?token=nosuchtoken&client=${ctx.clientId}`);
  assert.equal(status, 404);
  assert.equal(json.success, false);
});

test('GET /api/public/email-unsubscribe: a malformed token is rejected with 400', async () => {
  const { status } = await ctx.request('GET', `/api/public/email-unsubscribe?token=${encodeURIComponent('bad token!')}&client=${ctx.clientId}`);
  assert.equal(status, 400);
});

test('GET /api/public/email-unsubscribe: a malformed client id is rejected with 400', async () => {
  const { status } = await ctx.request('GET', '/api/public/email-unsubscribe?token=tok-x&client=not-alphanumeric!');
  assert.equal(status, 400);
});
