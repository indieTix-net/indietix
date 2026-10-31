import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "SkeletonKeyUsage"`);
  await ctx.pgClient.query(`DELETE FROM "SkeletonKey"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

async function insertTicket(qrCode, { expirationDate = '2099-01-01', checkedIn = false, status = 'valid' } = {}) {
  const result = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "CheckedIn", "Status")
     VALUES ($1, $2, '2026-01-01 19:00:00', 'Movie', 'Main', 'Movie', 'details', 'ITEM', $3, $4)
     RETURNING "ID"`,
    [qrCode, expirationDate, checkedIn, status]
  );
  return result.rows[0].ID;
}

// ---- /api/checkin (by QR code, raw SQL path, falls back to skeleton keys) ----

// Ported from the removed /api/products/:id/checkin route (2026-10-29) --
// the real QR-code route needs the same coverage.
// Regression (2026-10-29): /api/checkin never looked at Status, so voided
// tickets scanned in as if valid.
test('POST /api/checkin: refunded, cancelled, deleted and transferred tickets are refused and stay unchecked', async () => {
  for (const status of ['refunded', 'cancelled', 'deleted', 'transferred']) {
    const id = await insertTicket(`QR-VOID-${status}`, { status });
    const { status: code, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: `QR-VOID-${status}` } });
    assert.equal(code, 200);
    assert.equal(json.returnStatus, 'failed_ticket_not_valid', status);
    assert.equal(json.ticketStatus, status);
    const row = await ctx.pgClient.query(`SELECT "CheckedIn" FROM "QRCodeProduct" WHERE "ID" = $1`, [id]);
    assert.equal(row.rows[0].CheckedIn, false, status);
  }
});

test('POST /api/checkin: a ticket with a legacy NULL status still checks in', async () => {
  await insertTicket('QR-NULL-STATUS', { status: null });
  const { json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'QR-NULL-STATUS' } });
  assert.equal(json.returnStatus, 'successful_checkin');
});

test('POST /api/checkin: already-checked-in ticket is rejected without erroring', async () => {
  await insertTicket('QR-CKIN-2', { checkedIn: true });
  const { status, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'QR-CKIN-2' } });
  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'failed_already_checked_in');
});

test('POST /api/checkin: expired ticket is rejected', async () => {
  await insertTicket('QR-CKIN-3', { expirationDate: '2020-01-01' });
  const { status, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'QR-CKIN-3' } });
  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'failed_expired_qrcode');
});

test('POST /api/checkin: checks in a valid ticket by QR code', async () => {
  await insertTicket('QR-CKIN-4');
  const { status, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'QR-CKIN-4' } });
  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'successful_checkin');
});

test('POST /api/checkin: missing qrCode is a 400, not a crash', async () => {
  const { status, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_invalid_request');
});

test('POST /api/checkin: an unknown QR code with no matching skeleton key reports failed_no_QRCode', async () => {
  const { status, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'QR-NOWHERE' } });
  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'failed_no_QRCode');
});

test('POST /api/checkin: falls back to an active skeleton key and logs usage', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-1', 'comp', 'Staff comp key', true)`
  );
  const { status, json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'SK-1', eventName: 'Test Event' } });
  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'successful_skeleton_key_checkin');
  assert.equal(json.isSkeletonKey, true);
  const usage = await ctx.pgClient.query(`SELECT * FROM "SkeletonKeyUsage"`);
  assert.equal(usage.rows.length, 1);
});

test('POST /api/checkin: an inactive skeleton key is treated as not found', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-2', 'comp', 'Inactive key', false)`
  );
  const { json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'SK-2' } });
  assert.equal(json.returnStatus, 'failed_no_QRCode');
});

test('POST /api/checkin: skeleton key per-day limit is enforced', async () => {
  const keyResult = await ctx.pgClient.query(
    `INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive", "maxUsesPerDay") VALUES ('SK-3', 'comp', 'Limited key', true, 1) RETURNING "id"`
  );
  await ctx.pgClient.query(`INSERT INTO "SkeletonKeyUsage" ("skeletonKeyId") VALUES ($1)`, [keyResult.rows[0].id]);
  const { json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'SK-3' } });
  assert.equal(json.returnStatus, 'failed_skeleton_key_limit');
});

test('POST /api/checkin: an expired skeleton key is rejected even with uses remaining', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive", "expiresAt") VALUES ('SK-EXPIRED', 'comp', 'Past key', true, '2020-01-01')`
  );
  const { json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'SK-EXPIRED' } });
  assert.equal(json.returnStatus, 'failed_skeleton_key_expired');
});

test('POST /api/checkin: a skeleton key not yet past its expiration date still works', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive", "expiresAt") VALUES ('SK-FUTURE', 'comp', 'Future key', true, '2099-01-01')`
  );
  const { json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'SK-FUTURE' } });
  assert.equal(json.returnStatus, 'successful_skeleton_key_checkin');
});

test('POST /api/checkin: skeleton key lifetime use limit is enforced regardless of daily usage', async () => {
  await ctx.pgClient.query(
    `INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive", "maxTotalUses", "totalUses") VALUES ('SK-MAXED', 'comp', 'Maxed-out key', true, 3, 3)`
  );
  const { json } = await ctx.request('POST', '/api/checkin', { token: ctx.clientToken, body: { qrCode: 'SK-MAXED' } });
  assert.equal(json.returnStatus, 'failed_skeleton_key_total_limit');
});

// ---- Skeleton key CRUD ----

test('POST /api/skeleton-keys: creates a new skeleton key', async () => {
  const { status, json } = await ctx.request('POST', '/api/skeleton-keys', {
    token: ctx.clientToken, body: { qrCode: 'SK-NEW', keyType: 'test', description: 'For testing' }
  });
  assert.equal(status, 200);
  assert.equal(json.skeletonKey.qrCode, 'SK-NEW');
});

test('POST /api/skeleton-keys: accepts maxTotalUses and expiresAt', async () => {
  const { status, json } = await ctx.request('POST', '/api/skeleton-keys', {
    token: ctx.clientToken,
    body: { qrCode: 'SK-CAPPED', keyType: 'test', description: 'For testing', maxTotalUses: 5, expiresAt: '2099-01-01' }
  });
  assert.equal(status, 200);
  assert.equal(json.skeletonKey.maxTotalUses, 5);
  assert.equal(json.skeletonKey.expiresAt.slice(0, 10), '2099-01-01');
});

test('POST /api/skeleton-keys: duplicate qrCode rejected with 409', async () => {
  await ctx.pgClient.query(`INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-DUP', 'comp', 'desc', true)`);
  const { status } = await ctx.request('POST', '/api/skeleton-keys', {
    token: ctx.clientToken, body: { qrCode: 'SK-DUP', keyType: 'comp', description: 'desc' }
  });
  assert.equal(status, 409);
});

test('POST /api/skeleton-keys: missing required fields rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/skeleton-keys', { token: ctx.clientToken, body: { qrCode: 'SK-X' } });
  assert.equal(status, 400);
});

test('GET /api/skeleton-keys: lists existing skeleton keys', async () => {
  await ctx.pgClient.query(`INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-LIST', 'comp', 'desc', true)`);
  const { status, json } = await ctx.request('GET', '/api/skeleton-keys', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.ok(json.skeletonKeys.find(k => k.qrCode === 'SK-LIST'));
});

test('PATCH /api/skeleton-keys/:qrCode: toggles isActive', async () => {
  await ctx.pgClient.query(`INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-TOGGLE', 'comp', 'desc', true)`);
  const { status, json } = await ctx.request('PATCH', '/api/skeleton-keys/SK-TOGGLE', { token: ctx.clientToken, body: { isActive: false } });
  assert.equal(status, 200);
  assert.equal(json.skeletonKey.isActive, false);
});

test('PATCH /api/skeleton-keys/:qrCode: a nonexistent key returns 404', async () => {
  const { status } = await ctx.request('PATCH', '/api/skeleton-keys/SK-NOPE', { token: ctx.clientToken, body: { isActive: false } });
  assert.equal(status, 404);
});

// ---- Checkout ----

// Ported from the removed /api/products/:id/checkout route (2026-10-29).
test('POST /api/checkout: a not-checked-in ticket is rejected', async () => {
  await insertTicket('QR-COUT-2', { checkedIn: false });
  const { json } = await ctx.request('POST', '/api/checkout', { token: ctx.clientToken, body: { qrCode: 'QR-COUT-2' } });
  assert.equal(json.returnStatus, 'failed_already_checked_out');
});

test('POST /api/checkout: checks out by QR code', async () => {
  await insertTicket('QR-COUT-3', { checkedIn: true });
  const { json } = await ctx.request('POST', '/api/checkout', { token: ctx.clientToken, body: { qrCode: 'QR-COUT-3' } });
  assert.equal(json.returnStatus, 'successful_checkout');
});

test('POST /api/checkout: missing qrCode is a 400', async () => {
  const { status } = await ctx.request('POST', '/api/checkout', { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
});

// ---- Refund toggle ----

test('POST /api/products/:id/refund: toggles valid -> refunded', async () => {
  const id = await insertTicket('QR-REF-1', { status: 'valid' });
  const { status, json } = await ctx.request('POST', `/api/products/${id}/refund`, { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.newStatus, 'refunded');
});

test('POST /api/products/:id/refund: toggles refunded -> valid', async () => {
  const id = await insertTicket('QR-REF-2', { status: 'refunded' });
  const { json } = await ctx.request('POST', `/api/products/${id}/refund`, { token: ctx.clientToken });
  assert.equal(json.newStatus, 'valid');
});

