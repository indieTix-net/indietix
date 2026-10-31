// Server-side permission enforcement (2026-10-29). Every rule here was
// decided route by route; see the ---- SERVER-SIDE PERMISSIONS ---- block
// in src/app.mjs for the shared middleware/helpers these exercise.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, resetSquareHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({
    clientConfig: {
      SQUARE_ACCESS_TOKEN: 'super-secret-square-token',
      EVENT_LOCATIONS: ['Main Room'],
      USERS_NAMES: ['Staff One']
    }
  });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "Users"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
});

const NO_PERMS = { view: false, edit: false, checkIn: false, marketing: false, admin: false };
const only = (flag) => ({ ...NO_PERMS, [flag]: true });
let userSeq = 0;
const userWith = (permissions, dataFilter) =>
  ctx.insertUser({ username: `perm-user-${++userSeq}`, permissions, dataFilter });

async function insertTicket(qrCode, productName, { checkedIn = false } = {}) {
  const result = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "CheckedIn", "Status")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', $2, 'Main', 'Movie', 'details', 'ITEM', $3, 'valid')
     RETURNING "ID"`,
    [qrCode, productName, checkedIn]
  );
  return result.rows[0].ID;
}

async function insertOrderWithTicket(orderId, qrCode, productName) {
  const order = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID", "EmailAddress", "FirstName", "LastName", "Status", "OrderMetaData")
     VALUES ($1, 'buyer@example.com', 'Jane', 'Doe', 'Valid', '{}') RETURNING "ID"`,
    [orderId]
  );
  const dbOrderId = order.rows[0].ID;
  const ticketId = await insertTicket(qrCode, productName);
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`,
    [ticketId, dbOrderId]
  );
  return { dbOrderId, ticketId };
}

// ---- requirePermission: route -> flag matrix ----

// [method, path, body, a flag that should be allowed through]
const GATED_ROUTES = [
  ['GET', '/api/orders', undefined, 'view'],
  ['GET', '/api/products', undefined, 'checkIn'],
  ['GET', '/api/product_by_qrcode?search=nope', undefined, 'checkIn'],
  ['POST', '/api/checkin', { qrCode: 'nope' }, 'checkIn'],
  ['POST', '/api/checkout', { qrCode: 'nope' }, 'checkIn'],
  ['POST', '/api/presigned-download', { qrCode: 'nope' }, 'checkIn'],
  ['POST', '/api/presigned-upload', { fileName: 'x.jpg', contentType: 'image/jpeg', folder: 'not-allowed' }, 'edit'],
  ['POST', '/api/products/999999/refund', undefined, 'checkIn'],
  ['POST', '/api/products/999999/transfer', {}, 'checkIn'],
  ['GET', '/api/orders/999999/tickets', undefined, 'view'],
  ['POST', '/api/orders/999999/cancel', {}, 'edit'],
  ['GET', '/api/client/ui-config', undefined, 'checkIn'],
  ['GET', '/api/client/branding', undefined, 'marketing'],
  ['GET', '/api/dashboard/today', undefined, 'checkIn'],
  ['GET', '/api/square/showtimes-for-date', undefined, 'edit'],
  ['POST', '/api/insights/query', {}, 'admin'],
  ['GET', '/api/marketing/digest-settings', undefined, 'marketing'],
];

test('every gated route rejects a sub-user with no permission flags (403)', async () => {
  const { token } = await userWith(NO_PERMS);
  for (const [method, path, body] of GATED_ROUTES) {
    const { status, json } = await ctx.request(method, path, { token, body });
    assert.equal(status, 403, `${method} ${path} should be 403 with no flags`);
    assert.equal(json.returnStatus, 'failed_forbidden');
  }
});

test('every gated route lets through a sub-user holding the required flag', async () => {
  for (const [method, path, body, flag] of GATED_ROUTES) {
    const { token } = await userWith(only(flag));
    const { status } = await ctx.request(method, path, { token, body });
    assert.notEqual(status, 403, `${method} ${path} should allow '${flag}'`);
  }
});

test('the client login passes every permission check', async () => {
  for (const [method, path, body] of GATED_ROUTES) {
    const { status } = await ctx.request(method, path, { token: ctx.clientToken, body });
    assert.notEqual(status, 403, `${method} ${path} should allow the client login`);
  }
});

test('flags are independent: admin alone does not unlock orders or marketing', async () => {
  const { token } = await userWith(only('admin'));
  assert.equal((await ctx.request('GET', '/api/orders', { token })).status, 403);
  assert.equal((await ctx.request('GET', '/api/marketing/digest-settings', { token })).status, 403);
});

test('a view-only sub-user cannot reach edit-only routes', async () => {
  const { token } = await userWith(only('view'));
  const { status } = await ctx.request('GET', '/api/square/showtimes-for-date', { token });
  assert.equal(status, 403);
});

// User management, Client Settings and Skeleton Keys belong to the
// venue's master (client) login alone -- no flag unlocks them, not even admin.
const CLIENT_ONLY_ROUTES = [
  ['GET', '/api/users'],
  ['GET', '/api/client'],
  ['PUT', '/api/client', { contactName: 'Admin Person', clientEmail: 'admin@example.com' }],
  ['GET', '/api/skeleton-keys'],
  ['POST', '/api/skeleton-keys', {}],
  ['PATCH', '/api/skeleton-keys/NOPE', {}],
];

test('client-only routes reject a sub-user holding every flag, admin included', async () => {
  const { token } = await userWith({ view: true, edit: true, checkIn: true, marketing: true, admin: true });
  for (const [method, path, body] of CLIENT_ONLY_ROUTES) {
    const { status } = await ctx.request(method, path, { token, body });
    assert.equal(status, 403, `${method} ${path} should be client-login-only`);
  }
});

test('client-only routes let the client login through', async () => {
  for (const [method, path, body] of CLIENT_ONLY_ROUTES) {
    const { status } = await ctx.request(method, path, { token: ctx.clientToken, body });
    assert.notEqual(status, 403, `${method} ${path} should allow the client login`);
  }
});

// ---- Client settings ----

test('GET /api/client/ui-config: returns only the non-sensitive keys', async () => {
  const { token } = await userWith(only('checkIn'));
  const { status, json } = await ctx.request('GET', '/api/client/ui-config', { token });
  assert.equal(status, 200);
  assert.deepEqual(json.client.configuration.EVENT_LOCATIONS, ['Main Room']);
  assert.deepEqual(json.client.configuration.USERS_NAMES, ['Staff One']);
  assert.equal(json.client.configuration.SQUARE_ACCESS_TOKEN, undefined, 'secrets must never be in ui-config');
  for (const key of Object.keys(json.client.configuration)) {
    assert.ok(['EVENT_LOCATIONS', 'EVENT_DESCRIPTORS', 'SHOWTIME_BUFFER_MINUTES', 'USERS_NAMES'].includes(key), `unexpected key ${key}`);
  }
});

test('PUT /api/client: the client login can still change the client secret', async () => {
  const { status } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'Owner', clientEmail: 'owner@example.com', clientSecret: 'a-new-master-secret' }
  });
  assert.equal(status, 200);
});

// ---- Data filters on single-ticket routes ----

const FILTER_A = { datafilters: [{ event: 'Movie A' }] };

test('scanner lookup: a filtered user sees their own event\'s ticket but not another event\'s', async () => {
  await insertTicket('QR-A', 'Movie A');
  await insertTicket('QR-B', 'Movie B');
  const { token } = await userWith(only('checkIn'), FILTER_A);

  const own = await ctx.request('GET', '/api/product_by_qrcode?search=QR-A', { token });
  assert.equal(own.json.length, 1);
  const other = await ctx.request('GET', '/api/product_by_qrcode?search=QR-B', { token });
  assert.deepEqual(other.json, []);
});

test('check-in: a filtered user cannot check in another event\'s ticket, and it stays unchecked', async () => {
  const otherId = await insertTicket('QR-B', 'Movie B');
  await insertTicket('QR-A', 'Movie A');
  const { token } = await userWith(only('checkIn'), FILTER_A);

  const other = await ctx.request('POST', '/api/checkin', { token, body: { qrCode: 'QR-B' } });
  assert.equal(other.json.returnStatus, 'failed_no_QRCode');
  const row = await ctx.pgClient.query(`SELECT "CheckedIn" FROM "QRCodeProduct" WHERE "ID" = $1`, [otherId]);
  assert.equal(row.rows[0].CheckedIn, false);

  const own = await ctx.request('POST', '/api/checkin', { token, body: { qrCode: 'QR-A' } });
  assert.equal(own.json.returnStatus, 'successful_checkin');
});

test('check-out: a filtered user cannot check out another event\'s ticket', async () => {
  await insertTicket('QR-B', 'Movie B', { checkedIn: true });
  const { token } = await userWith(only('checkIn'), FILTER_A);
  const { json } = await ctx.request('POST', '/api/checkout', { token, body: { qrCode: 'QR-B' } });
  assert.equal(json.returnStatus, 'failed_no_QRCode');
});

test('ticket refund toggle: hidden from a filtered user for another event (404)', async () => {
  const otherId = await insertTicket('QR-B', 'Movie B');
  const { token } = await userWith(only('checkIn'), FILTER_A);
  const { status } = await ctx.request('POST', `/api/products/${otherId}/refund`, { token });
  assert.equal(status, 404);
});

test('ticket download link: hidden from a filtered user for another event (404)', async () => {
  await insertTicket('QR-B', 'Movie B');
  const { token } = await userWith(only('checkIn'), FILTER_A);
  const { status } = await ctx.request('POST', '/api/presigned-download', { token, body: { qrCode: 'QR-B' } });
  assert.equal(status, 404);
});

test('an unfiltered sub-user is not affected by data filtering', async () => {
  await insertTicket('QR-B', 'Movie B');
  const { token } = await userWith(only('checkIn'));
  const { json } = await ctx.request('GET', '/api/product_by_qrcode?search=QR-B', { token });
  assert.equal(json.length, 1);
});

// ---- Data filters + verified audit on order routes ----

test('order tickets: hidden from a filtered user for another event\'s order (404)', async () => {
  const { dbOrderId } = await insertOrderWithTicket('ORDER-B', 'QR-OB', 'Movie B');
  const { token } = await userWith(only('view'), FILTER_A);
  const { status } = await ctx.request('GET', `/api/orders/${dbOrderId}/tickets`, { token });
  assert.equal(status, 404);
});

test('order cancel: a filtered user cannot cancel another event\'s order', async () => {
  const { dbOrderId } = await insertOrderWithTicket('ORDER-B', 'QR-OB', 'Movie B');
  const { token } = await userWith(only('edit'), FILTER_A);
  const { status } = await ctx.request('POST', `/api/orders/${dbOrderId}/cancel`, {
    token, body: { cancelledBy: 'Staff One', cancelReason: 'test' }
  });
  assert.equal(status, 404);
  const order = await ctx.pgClient.query(`SELECT "Status" FROM "Order" WHERE "ID" = $1`, [dbOrderId]);
  assert.equal(order.rows[0].Status, 'Valid');
});

test('order cancel: records the logged-in account next to the UI-supplied name', async () => {
  const { dbOrderId } = await insertOrderWithTicket('ORDER-A', 'QR-OA', 'Movie A');
  const { id, token } = await userWith(only('edit'));
  const { status } = await ctx.request('POST', `/api/orders/${dbOrderId}/cancel`, {
    token, body: { cancelledBy: 'Somebody Else', cancelReason: 'test' }
  });
  assert.equal(status, 200);
  const order = await ctx.pgClient.query(`SELECT "OrderMetaData" FROM "Order" WHERE "ID" = $1`, [dbOrderId]);
  const meta = typeof order.rows[0].OrderMetaData === 'string' ? JSON.parse(order.rows[0].OrderMetaData) : order.rows[0].OrderMetaData;
  assert.equal(meta.cancel.cancelledBy, 'Somebody Else');
  assert.deepEqual(meta.cancel.cancelledByAccount, { userType: 'user', userId: id });
});

test('order delete: records the client login as the actor when the client does it', async () => {
  const { dbOrderId } = await insertOrderWithTicket('ORDER-A', 'QR-OA', 'Movie A');
  const { status } = await ctx.request('POST', `/api/orders/${dbOrderId}/delete`, {
    token: ctx.clientToken, body: { deletedBy: 'Owner', deleteReason: 'test order' }
  });
  assert.equal(status, 200);
  const order = await ctx.pgClient.query(`SELECT "OrderMetaData" FROM "Order" WHERE "ID" = $1`, [dbOrderId]);
  const meta = typeof order.rows[0].OrderMetaData === 'string' ? JSON.parse(order.rows[0].OrderMetaData) : order.rows[0].OrderMetaData;
  assert.deepEqual(meta.delete.deletedByAccount, { userType: 'client', clientId: ctx.clientId });
});

// ---- Order edit: phone normalization ----

test('order edit: a formatted US phone is stored as E.164', async () => {
  const { dbOrderId } = await insertOrderWithTicket('ORDER-A', 'QR-OA', 'Movie A');
  const { status } = await ctx.request('PUT', `/api/orders/${dbOrderId}/edit`, {
    token: ctx.clientToken,
    body: { firstName: 'Jane', lastName: 'Doe', phoneNumber: '(785) 555-1234', emailAddress: 'jane@example.com' }
  });
  assert.equal(status, 200);
  const order = await ctx.pgClient.query(`SELECT "PhoneNumber" FROM "Order" WHERE "ID" = $1`, [dbOrderId]);
  assert.equal(order.rows[0].PhoneNumber, '+17855551234');
});

test('order edit: an unparseable phone is rejected, not stored raw', async () => {
  const { dbOrderId } = await insertOrderWithTicket('ORDER-A', 'QR-OA', 'Movie A');
  const { status } = await ctx.request('PUT', `/api/orders/${dbOrderId}/edit`, {
    token: ctx.clientToken,
    body: { firstName: 'Jane', lastName: 'Doe', phoneNumber: 'call me maybe', emailAddress: 'jane@example.com' }
  });
  assert.equal(status, 400);
});
