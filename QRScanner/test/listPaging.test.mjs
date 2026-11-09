import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';
import { initializeModelForClient } from '../src/models/product.mjs';

// Server-side paging for the ticket and order lists, the faster ticket rows,
// and the guard that keeps an unpaged ticket list under Lambda's 6 MB limit.
let ctx, sequelize, QRCodeProduct;

before(async () => {
  ctx = await startTestServer();
  // The model as the app builds it, to compare the fast rows against.
  const { host, port, user, password, database } = ctx.dbConfig;
  ({ QRCodeProduct } = await initializeModelForClient(database, { host, port: String(port), username: user, password, ssl: 'false' }));
  sequelize = QRCodeProduct.sequelize;
});
after(async () => { await sequelize.close(); await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
});

// n tickets for one show, numbered from 1 (newest has the highest number).
async function insertTickets(n, { name = 'Paged Movie', date = '2026-03-14 19:30:00', type = 'Movie' } = {}) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "FirstName", "EmailAddress", "ProductPrice", "Status", "CreatedDate")
     SELECT $2 || '-' || i, '2099-01-01', $3::timestamp, $2, 'LOC', $4, 'Sat 03-14-2026 7:30 PM (Main)', 'ITEM', 'Buyer' || i, 'buyer' || i || '@example.com', 12.5, 'valid', '2026-03-01 18:05:00'::timestamp + i * interval '1 minute'
     FROM generate_series(1, $1) AS i`,
    [n, name, date, type]);
}

test('GET /api/products: rows match the model exactly (dates formatted the same way)', async () => {
  await insertTickets(3);
  await ctx.pgClient.query(`UPDATE "QRCodeProduct" SET "ExpirationDate" = '2026-12-31 23:59:00', "CheckedIn" = true WHERE "QRCode" = 'Paged Movie-2'`);
  const { status, json } = await ctx.request('GET', '/api/products', { token: ctx.clientToken });
  assert.equal(status, 200);
  const expected = (await QRCodeProduct.findAll({ order: [['id', 'DESC']] })).map(p => p.toJSON());
  assert.deepEqual(json, JSON.parse(JSON.stringify(expected)));
  assert.match(json[0].productDate, /^March 1[45], 2026 at /); // the getter's text (exact time depends on the machine's time zone)
});

test('GET /api/products?page: one page, newest first, with the total; filters still apply', async () => {
  await insertTickets(60);
  await insertTickets(5, { name: 'Other Show', date: '2026-04-01 20:00:00' });
  const first = await ctx.request('GET', '/api/products?page=1&pageSize=25&search=Paged', { token: ctx.clientToken });
  assert.equal(first.status, 200);
  assert.equal(first.json.total, 60);
  assert.equal(first.json.page, 1);
  assert.equal(first.json.pageSize, 25);
  assert.equal(first.json.tickets.length, 25);
  assert.equal(first.json.tickets[0].qrCode, 'Paged Movie-60');
  const last = await ctx.request('GET', '/api/products?page=3&pageSize=25&search=Paged', { token: ctx.clientToken });
  assert.deepEqual(last.json.tickets.map(t => t.qrCode), Array.from({ length: 10 }, (_, i) => `Paged Movie-${10 - i}`));
  const byDate = await ctx.request('GET', '/api/products?page=1&startDate=2026-03-31&endDate=2026-04-02', { token: ctx.clientToken });
  assert.equal(byDate.json.total, 5);
  assert.equal(byDate.json.pageSize, 100); // an unlisted size falls back to 100
});

test('GET /api/products?page: a staff login\'s data filter limits the total too', async () => {
  await insertTickets(8);
  await insertTickets(4, { name: 'Live Night', type: 'Live' });
  const { token } = await ctx.insertUser({
    username: 'pager-live', permissions: { view: true, edit: false, checkIn: true, marketing: false, admin: false },
    dataFilter: { datafilters: [{ eventType: 'Live' }] }
  });
  const { json } = await ctx.request('GET', '/api/products?page=1&pageSize=25', { token });
  assert.equal(json.total, 4);
  assert.ok(json.tickets.every(t => t.name === 'Live Night'));
});

test('GET /api/products without paging refuses a list too big for one response, with a message', async () => {
  await insertTickets(7501);
  const { status, json } = await ctx.request('GET', '/api/products', { token: ctx.clientToken });
  assert.equal(status, 413);
  assert.equal(json.error, 'too_many_tickets');
  assert.equal(json.total, 7501);
  assert.match(json.message, /7,501 tickets match.*shorter date range/);
  const paged = await ctx.request('GET', '/api/products?page=301&pageSize=25', { token: ctx.clientToken });
  assert.equal(paged.status, 200);
  assert.equal(paged.json.tickets.length, 1);
});

test('GET /api/orders?page: pages with a total; without page, the newest 500 as before', async () => {
  await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID", "FirstName") SELECT 'ORD-' || i, 'Pat' FROM generate_series(1, 120) AS i`);
  const page2 = await ctx.request('GET', '/api/orders?page=2&pageSize=50', { token: ctx.clientToken });
  assert.equal(page2.status, 200);
  assert.equal(page2.json.total, 120);
  assert.equal(page2.json.orders.length, 50);
  assert.equal(page2.json.orders[0].OrderID, 'ORD-70');
  const searched = await ctx.request('GET', '/api/orders?page=1&search=ORD-11', { token: ctx.clientToken });
  assert.equal(searched.json.total, 11); // ORD-11 and ORD-110..119
  const unpaged = await ctx.request('GET', '/api/orders', { token: ctx.clientToken });
  assert.equal(unpaged.json.orders.length, 120);
  assert.equal(unpaged.json.truncated, false);
});
