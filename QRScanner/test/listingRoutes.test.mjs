import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "SkeletonKey"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
});

async function insertTicket({ qrCode, productName = 'Movie', firstName = null, lastName = null, emailAddress = null, productDate = '2026-01-01 19:00:00' } = {}) {
  const result = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "FirstName", "LastName", "EmailAddress")
     VALUES ($1, '2099-01-01', $2, $3, 'Main', 'Movie', 'details', 'ITEM', $4, $5, $6)
     RETURNING "ID"`,
    [qrCode, productDate, productName, firstName, lastName, emailAddress]
  );
  return result.rows[0].ID;
}

// ---- /api/orders ----

test('GET /api/orders: lists orders newest-first', async () => {
  await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID") VALUES ('ORDER-A'), ('ORDER-B')`);
  const { status, json } = await ctx.request('GET', '/api/orders', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.orders.length, 2);
  assert.equal(json.orders[0].OrderID, 'ORDER-B');
  assert.equal(json.truncated, false);
});

test('GET /api/orders: search matches across order id/name/email/phone', async () => {
  await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID", "FirstName", "EmailAddress") VALUES ('ORDER-SEARCH-1', 'Alice', 'alice@example.com')`);
  await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID", "FirstName", "EmailAddress") VALUES ('ORDER-SEARCH-2', 'Bob', 'bob@example.com')`);
  const { json } = await ctx.request('GET', '/api/orders?search=alice', { token: ctx.clientToken });
  assert.equal(json.orders.length, 1);
  assert.equal(json.orders[0].FirstName, 'Alice');
});

test('GET /api/orders: date range filters by CreatedDate', async () => {
  await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID", "CreatedDate") VALUES ('ORDER-OLD', '2020-01-01')`);
  await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID", "CreatedDate") VALUES ('ORDER-NEW', NOW())`);
  const { json } = await ctx.request('GET', '/api/orders?startDate=2025-01-01&endDate=2030-01-01', { token: ctx.clientToken });
  assert.equal(json.orders.length, 1);
  assert.equal(json.orders[0].OrderID, 'ORDER-NEW');
});

test('GET /api/orders: a sub-user with a data filter only sees matching orders (via ticket join)', async () => {
  const orderA = await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID") VALUES ('ORDER-FILTER-MATCH') RETURNING "ID"`);
  const orderB = await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID") VALUES ('ORDER-FILTER-NOMATCH') RETURNING "ID"`);
  const ticketA = await insertTicket({ qrCode: 'QR-FILTER-A', productName: 'Wanted Movie' });
  const ticketB = await insertTicket({ qrCode: 'QR-FILTER-B', productName: 'Other Movie' });
  await ctx.pgClient.query(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`, [ticketA, orderA.rows[0].ID]);
  await ctx.pgClient.query(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`, [ticketB, orderB.rows[0].ID]);

  const { token } = await ctx.insertUser({
    username: 'filtereduser',
    dataFilter: { datafilters: [{ event: 'Wanted Movie' }] }
  });
  const { status, json } = await ctx.request('GET', '/api/orders', { token });
  assert.equal(status, 200);
  assert.equal(json.orders.length, 1);
  assert.equal(json.orders[0].OrderID, 'ORDER-FILTER-MATCH');
});

// ---- /api/products ----

test('GET /api/products: returns all tickets as a plain array', async () => {
  await insertTicket({ qrCode: 'QR-PROD-1' });
  const { status, json } = await ctx.request('GET', '/api/products', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(Array.isArray(json), true);
  assert.equal(json.length, 1);
});

test('GET /api/products: search matches name/email/phone fields', async () => {
  await insertTicket({ qrCode: 'QR-PROD-2', emailAddress: 'findme@example.com' });
  await insertTicket({ qrCode: 'QR-PROD-3', emailAddress: 'other@example.com' });
  const { json } = await ctx.request('GET', '/api/products?search=findme', { token: ctx.clientToken });
  assert.equal(json.length, 1);
});

test('GET /api/products: date range filters by ProductDate', async () => {
  await insertTicket({ qrCode: 'QR-PROD-OLD', productDate: '2020-01-01 19:00:00' });
  await insertTicket({ qrCode: 'QR-PROD-NEW', productDate: '2026-06-01 19:00:00' });
  const { json } = await ctx.request('GET', '/api/products?startDate=2025-01-01&endDate=2030-01-01', { token: ctx.clientToken });
  assert.equal(json.length, 1);
  assert.equal(json[0].qrCode, 'QR-PROD-NEW');
});

test('GET /api/products: a sub-user with an event-name data filter only sees matching tickets', async () => {
  await insertTicket({ qrCode: 'QR-PROD-FILTER-A', productName: 'Wanted Movie' });
  await insertTicket({ qrCode: 'QR-PROD-FILTER-B', productName: 'Other Movie' });
  const { token } = await ctx.insertUser({
    username: 'filtereduser2',
    dataFilter: { datafilters: [{ event: 'Wanted Movie' }] }
  });
  const { json } = await ctx.request('GET', '/api/products', { token });
  assert.equal(json.length, 1);
  assert.equal(json[0].qrCode, 'QR-PROD-FILTER-A');
});

// ---- /api/product_by_qrcode ----

test('GET /api/product_by_qrcode: finds a regular ticket by exact QR code', async () => {
  await insertTicket({ qrCode: 'QR-FIND-ME' });
  const { status, json } = await ctx.request('GET', '/api/product_by_qrcode?search=QR-FIND-ME', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].qrCode, 'QR-FIND-ME');
});

test('GET /api/product_by_qrcode: falls back to skeleton keys and formats them like a product', async () => {
  await ctx.pgClient.query(`INSERT INTO "SkeletonKey" ("qrCode", "keyType", "description", "isActive") VALUES ('SK-FIND', 'comp', 'Staff comp', true)`);
  const { status, json } = await ctx.request('GET', '/api/product_by_qrcode?search=SK-FIND', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(json[0].isSkeletonKey, true);
  assert.match(json[0].productName, /Skeleton Key/);
});

test('GET /api/product_by_qrcode: no match anywhere returns an empty array, not an error', async () => {
  const { status, json } = await ctx.request('GET', '/api/product_by_qrcode?search=NOPE', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json, []);
});

test('GET /api/product_by_qrcode: no search param returns an empty array immediately', async () => {
  const { status, json } = await ctx.request('GET', '/api/product_by_qrcode', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json, []);
});

