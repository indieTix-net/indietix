// Public API v1 (2026-10-29). See the ---- PUBLIC API v1 ---- block in
// src/app.mjs and src/public/openapi.yaml.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "ApiIdempotency"`);
  await ctx.pgClient.query(`DELETE FROM "ApiKey"`);
  await ctx.pgClient.query(`DELETE FROM "SkeletonKey"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
});

async function createKey(scopes, { dataFilter, name = 'Test key' } = {}) {
  const { status, json } = await ctx.request('POST', '/api/api-keys', {
    token: ctx.clientToken, body: { name, scopes, dataFilter }
  });
  assert.equal(status, 201, JSON.stringify(json));
  return json.key;
}

const v1 = (method, path, key, opts = {}) => ctx.request(method, path, { token: key, ...opts });

async function insertTicket(qrCode, {
  productName = 'Movie A', productDate = '2026-07-04 19:30:00', status = 'valid',
  checkedIn = false, expirationDate = '2099-01-01', price = 10, showtimeId = 'MOD-1'
} = {}) {
  const result = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType",
       "ProductDetails", "ProductID", "CheckedIn", "Status", "ProductPrice", "FirstName", "LastName", "EmailAddress", "PhoneNumber", "ProductMetadata")
     VALUES ($1, $2, $3, $4, 'Main', 'Movie', 'details', 'ITEM', $5, $6, $7, 'Jane', 'Doe', 'jane@example.com', '+15555550100', $8)
     RETURNING "ID"`,
    [qrCode, expirationDate, productDate, productName, checkedIn, status, price,
      JSON.stringify({ modifiers: [{ catalog_object_id: showtimeId, name: 'Sat 07-04-2026 7:30 PM (Main)' }] })]
  );
  return result.rows[0].ID;
}

async function insertOrder(orderId, ticketIds) {
  const result = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID", "EmailAddress", "FirstName", "LastName", "PhoneNumber", "Status", "OrderMetaData")
     VALUES ($1, 'jane@example.com', 'Jane', 'Doe', '+15555550100', 'Valid', '{}') RETURNING "ID"`,
    [orderId]
  );
  for (const tid of ticketIds) {
    await ctx.pgClient.query(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`, [tid, result.rows[0].ID]);
  }
  return result.rows[0].ID;
}

// ---- Key management (operator UI) ----

test('API keys: the client login creates a key; the full key is returned once and never listed', async () => {
  const key = await createKey(['tickets:read']);
  assert.match(key, /^itk_TESTCLIENT123_[A-Za-z0-9_-]{40,}$/);
  const { json } = await ctx.request('GET', '/api/api-keys', { token: ctx.clientToken });
  assert.equal(json.keys.length, 1);
  assert.ok(!JSON.stringify(json).includes(key.split('_').pop()), 'secret must never be listed');
  const row = await ctx.pgClient.query(`SELECT "KeyHash" FROM "ApiKey"`);
  assert.equal(row.rows[0].KeyHash.length, 64);
});

test('API keys: managing keys is client-login-only', async () => {
  const { token } = await ctx.insertUser({ username: 'admin-sub', permissions: { view: true, edit: true, checkIn: true, marketing: true, admin: true } });
  assert.equal((await ctx.request('GET', '/api/api-keys', { token })).status, 403);
  assert.equal((await ctx.request('POST', '/api/api-keys', { token, body: { name: 'x', scopes: ['tickets:read'] } })).status, 403);
});

test('API keys: unknown scopes and orders:pii on its own are rejected', async () => {
  const bad = await ctx.request('POST', '/api/api-keys', { token: ctx.clientToken, body: { name: 'x', scopes: ['everything'] } });
  assert.equal(bad.status, 400);
  const piiOnly = await ctx.request('POST', '/api/api-keys', { token: ctx.clientToken, body: { name: 'x', scopes: ['orders:pii'] } });
  assert.equal(piiOnly.status, 400);
});

// ---- Auth ----

test('v1 auth: missing, malformed, wrong-secret, unknown-venue and revoked keys all get the same 401', async () => {
  const key = await createKey(['tickets:read']);
  const attempts = [
    undefined,
    'not-a-key',
    key.slice(0, -4) + 'AAAA',
    key.replace('TESTCLIENT123', 'NOSUCHVENUE99'),
  ];
  for (const k of attempts) {
    const { status, json } = await v1('GET', '/v1/tickets', k);
    assert.equal(status, 401, String(k));
    assert.equal(json.error.code, 'unauthorized');
  }
  const { json: list } = await ctx.request('GET', '/api/api-keys', { token: ctx.clientToken });
  assert.equal((await ctx.request('POST', `/api/api-keys/${list.keys[0].id}/revoke`, { token: ctx.clientToken })).status, 200);
  assert.equal((await v1('GET', '/v1/tickets', key)).status, 401);
});

test('v1 auth: a key without the needed scope gets 403 insufficient_scope', async () => {
  const key = await createKey(['tickets:read']);
  const { status, json } = await v1('GET', '/v1/orders', key);
  assert.equal(status, 403);
  assert.equal(json.error.code, 'insufficient_scope');
});

test('v1 auth: more than 120 requests a minute on one key gets 429', async () => {
  const key = await createKey(['tickets:read']);
  await ctx.pgClient.query(`UPDATE "ApiKey" SET "RateWindowStart" = LOCALTIMESTAMP, "RateWindowCount" = 120`);
  const { status, json, headers } = await v1('GET', '/v1/tickets', key);
  assert.equal(status, 429);
  assert.equal(json.error.code, 'rate_limited');
  assert.equal(headers.get('retry-after'), '60');
});

test('v1: unknown paths answer in the v1 error shape', async () => {
  const key = await createKey(['tickets:read']);
  const { status, json } = await v1('GET', '/v1/nope', key);
  assert.equal(status, 404);
  assert.equal(json.error.code, 'not_found');
});

// ---- Tickets ----

test('GET /v1/tickets: paginates with next_cursor and converts showtimes to ISO with the venue offset', async () => {
  await insertTicket('T-1', { productDate: '2026-07-04 19:30:00' });
  await insertTicket('T-2', { productDate: '2026-01-10 19:00:00' });
  await insertTicket('T-3');
  const key = await createKey(['tickets:read']);

  const page1 = await v1('GET', '/v1/tickets?limit=2', key);
  assert.equal(page1.status, 200);
  assert.equal(page1.json.data.length, 2);
  assert.equal(page1.json.data[0].starts_at, '2026-07-04T19:30:00-05:00'); // CDT
  assert.equal(page1.json.data[1].starts_at, '2026-01-10T19:00:00-06:00'); // CST
  assert.ok(page1.json.next_cursor);

  const page2 = await v1('GET', `/v1/tickets?limit=2&cursor=${page1.json.next_cursor}`, key);
  assert.equal(page2.json.data.length, 1);
  assert.equal(page2.json.data[0].qr_code, 'T-3');
  assert.equal(page2.json.next_cursor, null);
});

test('GET /v1/tickets: buyer details only with orders:pii', async () => {
  await insertTicket('T-1');
  const plain = await v1('GET', '/v1/tickets', await createKey(['tickets:read']));
  assert.equal(plain.json.data[0].buyer, undefined);
  const pii = await v1('GET', '/v1/tickets', await createKey(['tickets:read', 'orders:pii']));
  assert.equal(pii.json.data[0].buyer.email, 'jane@example.com');
});

test('GET /v1/tickets: filters by event, showtime and status', async () => {
  await insertTicket('T-A', { productName: 'Movie A', showtimeId: 'MOD-A' });
  await insertTicket('T-B', { productName: 'Movie B', showtimeId: 'MOD-B', status: 'refunded' });
  const key = await createKey(['tickets:read']);
  assert.deepEqual((await v1('GET', '/v1/tickets?event=movie%20b', key)).json.data.map(t => t.qr_code), ['T-B']);
  assert.deepEqual((await v1('GET', '/v1/tickets?showtime=MOD-A', key)).json.data.map(t => t.qr_code), ['T-A']);
  assert.deepEqual((await v1('GET', '/v1/tickets?status=refunded', key)).json.data.map(t => t.qr_code), ['T-B']);
});

test('GET /v1/tickets/:qrCode: a data-filtered key cannot see another event\'s ticket', async () => {
  await insertTicket('T-A', { productName: 'Movie A' });
  await insertTicket('T-B', { productName: 'Movie B' });
  const key = await createKey(['tickets:read'], { dataFilter: { datafilters: [{ event: 'Movie A' }] } });
  assert.equal((await v1('GET', '/v1/tickets/T-A', key)).status, 200);
  const hidden = await v1('GET', '/v1/tickets/T-B', key);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error.code, 'ticket_not_found');
});

test('GET /v1/tickets: an "event name contains" filter on a key limits the list', async () => {
  await insertTicket('T-A', { productName: 'Jazz Night' });
  await insertTicket('T-B', { productName: 'Late Jazz Night' });
  await insertTicket('T-C', { productName: 'Jaws' });
  const key = await createKey(['tickets:read'], { dataFilter: { datafilters: [{ eventContains: 'jazz' }] } });
  const { json } = await v1('GET', '/v1/tickets', key);
  assert.deepEqual(json.data.map(t => t.qr_code).sort(), ['T-A', 'T-B']);
});

// ---- Check-ins ----

test('POST /v1/checkins: checks in a valid ticket, then refuses a second check-in with 409', async () => {
  await insertTicket('T-1');
  const key = await createKey(['checkin:write']);
  const first = await v1('POST', '/v1/checkins', key, { body: { qr_code: 'T-1' } });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.checked_in, true);
  const second = await v1('POST', '/v1/checkins', key, { body: { qr_code: 'T-1' } });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'ticket_already_checked_in');
});

test('POST /v1/checkins: refunded, cancelled, deleted and transferred tickets are refused', async () => {
  const key = await createKey(['checkin:write']);
  for (const status of ['refunded', 'cancelled', 'deleted', 'transferred']) {
    await insertTicket(`T-${status}`, { status });
    const { status: code, json } = await v1('POST', '/v1/checkins', key, { body: { qr_code: `T-${status}` } });
    assert.equal(code, 409, status);
    assert.equal(json.error.code, 'ticket_not_valid');
  }
  const still = await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "QRCodeProduct" WHERE "CheckedIn"`);
  assert.equal(still.rows[0].n, 0);
});

test('POST /v1/checkins: an expired ticket is refused', async () => {
  await insertTicket('T-OLD', { expirationDate: '2020-01-01' });
  const { status, json } = await v1('POST', '/v1/checkins', await createKey(['checkin:write']), { body: { qr_code: 'T-OLD' } });
  assert.equal(status, 409);
  assert.equal(json.error.code, 'ticket_expired');
});

test('POST /v1/checkins: skeleton keys are never accepted through the API', async () => {
  await ctx.pgClient.query(`INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-1', 'comp', 'Staff comp', true)`);
  const { status, json } = await v1('POST', '/v1/checkins', await createKey(['checkin:write']), { body: { qr_code: 'SK-1' } });
  assert.equal(status, 404);
  assert.equal(json.error.code, 'ticket_not_found');
});

test('POST /v1/checkins: a retried request with the same Idempotency-Key replays the original 201', async () => {
  await insertTicket('T-1');
  const key = await createKey(['checkin:write']);
  const headers = { 'Idempotency-Key': 'scan-abc-123' };
  const first = await v1('POST', '/v1/checkins', key, { body: { qr_code: 'T-1' }, headers });
  const retry = await v1('POST', '/v1/checkins', key, { body: { qr_code: 'T-1' }, headers });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(retry.json, first.json);
});

test('POST /v1/checkins/:qrCode/undo: reverses a check-in; undoing again is a 409', async () => {
  await insertTicket('T-1', { checkedIn: true });
  const key = await createKey(['checkin:write']);
  const undo = await v1('POST', '/v1/checkins/T-1/undo', key);
  assert.equal(undo.status, 200);
  assert.equal(undo.json.data.checked_in, false);
  const again = await v1('POST', '/v1/checkins/T-1/undo', key);
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'ticket_not_checked_in');
});

test('POST /v1/checkins: a data-filtered key cannot check in another event\'s ticket', async () => {
  await insertTicket('T-B', { productName: 'Movie B' });
  const key = await createKey(['checkin:write'], { dataFilter: { datafilters: [{ event: 'Movie A' }] } });
  assert.equal((await v1('POST', '/v1/checkins', key, { body: { qr_code: 'T-B' } })).status, 404);
});

// ---- Orders ----

test('GET /v1/orders and /v1/orders/:id: totals, tickets, and buyer only with orders:pii', async () => {
  const t1 = await insertTicket('T-1', { price: 12.5 });
  const t2 = await insertTicket('T-2', { price: 7.5 });
  const orderId = await insertOrder('SQ-ORDER-1', [t1, t2]);

  const plainKey = await createKey(['orders:read']);
  const list = await v1('GET', '/v1/orders', plainKey);
  assert.equal(list.status, 200);
  assert.equal(list.json.data[0].ticket_count, 2);
  assert.equal(list.json.data[0].total, 20);
  assert.equal(list.json.data[0].buyer, undefined);

  const piiKey = await createKey(['orders:read', 'orders:pii']);
  const one = await v1('GET', `/v1/orders/${orderId}`, piiKey);
  assert.equal(one.json.data.square_order_id, 'SQ-ORDER-1');
  assert.equal(one.json.data.buyer.last_name, 'Doe');
  assert.equal(one.json.data.tickets.length, 2);
});

test('GET /v1/orders: a data-filtered key only sees orders with a ticket in its filter', async () => {
  const ta = await insertTicket('T-A', { productName: 'Movie A' });
  const tb = await insertTicket('T-B', { productName: 'Movie B' });
  await insertOrder('ORDER-A', [ta]);
  const orderB = await insertOrder('ORDER-B', [tb]);
  const key = await createKey(['orders:read'], { dataFilter: { datafilters: [{ event: 'Movie A' }] } });
  assert.deepEqual((await v1('GET', '/v1/orders', key)).json.data.map(o => o.square_order_id), ['ORDER-A']);
  assert.equal((await v1('GET', `/v1/orders/${orderB}`, key)).status, 404);
});

// ---- Reports ----

test('GET /v1/reports/sales: per-showtime sold, checked-in, refunded and revenue', async () => {
  await insertTicket('T-1', { price: 10, checkedIn: true });
  await insertTicket('T-2', { price: 10 });
  await insertTicket('T-3', { price: 10, status: 'refunded' });
  const { status, json } = await v1('GET', '/v1/reports/sales?from=2026-07-04&to=2026-07-04', await createKey(['reports:read']));
  assert.equal(status, 200);
  assert.deepEqual(json.data, [{
    event: 'Movie A', starts_at: '2026-07-04T19:30:00-05:00', sold: 2, checked_in: 1, refunded: 1, revenue: 20
  }]);
});

test('GET /v1/reports/sales: rejects a bad date or group_by', async () => {
  const key = await createKey(['reports:read']);
  assert.equal((await v1('GET', '/v1/reports/sales?from=July', key)).status, 400);
  assert.equal((await v1('GET', '/v1/reports/sales?from=2026-07-04&group_by=day', key)).status, 400);
});

// ---- Showtimes ----

test('GET /v1/showtimes: reads showtimes from the Square catalog within the date range, skipping archived items', async () => {
  squareHandlers.searchCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [
        { type: 'ITEM', id: 'ITEM-1', item_data: { name: 'Movie A', modifier_list_info: [{ modifier_list_id: 'ML-1' }] } },
        { type: 'ITEM', id: 'ITEM-OLD', item_data: { name: 'Old Movie', is_archived: true, modifier_list_info: [{ modifier_list_id: 'ML-1' }] } }
      ],
      related_objects: [{
        type: 'MODIFIER_LIST', id: 'ML-1',
        modifier_list_data: { modifiers: [
          { id: 'MOD-1', modifier_data: { name: 'Sat 07-04-2026 7:30 PM (Main Room)' } },
          { id: 'MOD-2', modifier_data: { name: 'Sat 08-15-2026 2:00 PM (Little Theater)' } }
        ] }
      }]
    })
  });
  const { status, json } = await v1('GET', '/v1/showtimes?from=2026-07-01&to=2026-07-31', await createKey(['showtimes:read']));
  assert.equal(status, 200);
  assert.equal(json.data.length, 1);
  assert.deepEqual(
    { id: json.data[0].id, title: json.data[0].title, starts_at: json.data[0].starts_at, location: json.data[0].location },
    { id: 'MOD-1', title: 'Movie A', starts_at: '2026-07-04T19:30:00-05:00', location: 'Main Room' }
  );
});

test('GET /v1/orders: from/to filter on the venue-local creation date', async () => {
  const t1 = await insertTicket('T-1');
  await insertOrder('ORDER-NOW', [t1]);
  const key = await createKey(['orders:read']);
  assert.equal((await v1('GET', '/v1/orders?from=2000-01-01&to=2099-12-31', key)).json.data.length, 1);
  assert.equal((await v1('GET', '/v1/orders?from=2099-01-01', key)).json.data.length, 0);
  assert.equal((await v1('GET', '/v1/orders?to=2000-01-01', key)).json.data.length, 0);
  assert.equal((await v1('GET', '/v1/orders?from=yesterday', key)).status, 400);
});

// ---- Spec stays in step with the code ----

test('openapi.yaml documents exactly the /v1 routes app.mjs serves', () => {
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const spec = readFileSync(new URL('../src/public/openapi.yaml', import.meta.url), 'utf8');

  const codeRoutes = new Set(
    [...app.matchAll(/app\.(get|post|put|patch|delete)\('(\/v1\/[^']+)'/g)]
      .map(([, method, path]) => `${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`)
  );

  const specRoutes = new Set();
  let currentPath = null;
  for (const line of spec.split('\n')) {
    const pathMatch = line.match(/^  (\/v1\/\S+):\s*$/);
    if (pathMatch) { currentPath = pathMatch[1]; continue; }
    if (/^\S/.test(line)) currentPath = null;
    const opMatch = currentPath && line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (opMatch) specRoutes.add(`${opMatch[1].toUpperCase()} ${currentPath}`);
  }

  assert.ok(codeRoutes.size >= 8, `expected the 8 v1 routes, found ${codeRoutes.size}`);
  assert.deepEqual([...codeRoutes].sort(), [...specRoutes].sort());
});

