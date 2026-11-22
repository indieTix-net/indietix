import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

// ---- ORDER <-> TICKET LINKS ----
// The Tickets page links each ticket's order number to order.html?order=<ID>,
// and the Orders page links each order number to products.html?order=<ID>.
// Both list routes take ?order= (ignoring no filters, adding none of their
// own dates), and every ticket in the list says which order it's on.

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  for (const t of ['QRCodeProductToOrder', 'QRCodeProduct', 'Order']) await ctx.pgClient.query(`DELETE FROM "${t}"`);
});

async function order(number, tickets) {
  const id = (await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID", "FirstName") VALUES ($1, 'Buyer') RETURNING "ID"`, [number])).rows[0].ID;
  const ticketIds = [];
  for (const { name = 'Movie', type = 'Movie', date = '2026-01-01 19:00:00' } of tickets) {
    const ticketId = (await ctx.pgClient.query(
      `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID")
       VALUES ($1, '2099-01-01', $2, $3, 'Main', $4, 'details', 'ITEM') RETURNING "ID"`,
      [`QR-${number}-${ticketIds.length}`, date, name, type])).rows[0].ID;
    await ctx.pgClient.query(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`, [ticketId, id]);
    ticketIds.push(ticketId);
  }
  return { id, ticketIds };
}
const get = (path, token = ctx.clientToken) => ctx.request('GET', path, { token });

test('tickets: each ticket carries its order (database ID and Square order number); a ticket with no order says so', async () => {
  const a = await order('SQ-ORDER-A', [{}]);
  await ctx.pgClient.query(`INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID")
    VALUES ('QR-LOOSE', '2099-01-01', '2026-01-01 19:00:00', 'Comp', 'Main', 'Movie', 'details', 'ITEM')`);
  const { status, json } = await get('/api/products?page=1&pageSize=25');
  assert.equal(status, 200);
  const byQr = Object.fromEntries(json.tickets.map((t) => [t.qrCode, t.order]));
  assert.deepEqual(byQr['QR-SQ-ORDER-A-0'], { id: a.id, number: 'SQ-ORDER-A' });
  assert.equal(byQr['QR-LOOSE'], null);
});

test('tickets ?order=: all of that order\'s tickets, whatever their show dates, and no others', async () => {
  const a = await order('SQ-ORDER-A', [{ date: '2025-03-01 19:00:00' }, { date: '2030-06-07 19:00:00' }]);
  await order('SQ-ORDER-B', [{}]);
  const { status, json } = await get(`/api/products?page=1&pageSize=25&order=${a.id}`);
  assert.equal(status, 200);
  assert.deepEqual(json.tickets.map((t) => t.id).sort(), [...a.ticketIds].sort());
  assert.equal(json.total, 2);
});

test('orders ?order=: just that order', async () => {
  await order('SQ-ORDER-A', [{}]);
  const b = await order('SQ-ORDER-B', [{}]);
  const { status, json } = await get(`/api/orders?page=1&pageSize=25&order=${b.id}`);
  assert.equal(status, 200);
  assert.deepEqual(json.orders.map((o) => o.OrderID), ['SQ-ORDER-B']);
  assert.equal(json.total, 1);
});

test('?order= must be an order\'s ID (anything else is a 400, not a query)', async () => {
  for (const bad of ['abc', '0', '-1', '1;DROP', '1.5']) {
    assert.equal((await get(`/api/products?order=${encodeURIComponent(bad)}`)).status, 400, bad);
    assert.equal((await get(`/api/orders?order=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
});

test('a sub-user\'s data filter still applies through a link', async () => {
  const mixed = await order('SQ-ORDER-MIXED', [{ name: 'Jazz Night', type: 'Live' }, { name: 'Movie Night', type: 'Movie' }]);
  const { token } = await ctx.insertUser({ username: 'live-only', dataFilter: { datafilters: [{ eventType: 'live' }] } });
  const tickets = (await get(`/api/products?page=1&pageSize=25&order=${mixed.id}`, token)).json.tickets;
  assert.deepEqual(tickets.map((t) => t.name), ['Jazz Night'], 'the movie ticket on the same order stays hidden');

  const movieOnly = await order('SQ-ORDER-MOVIE', [{ name: 'Movie Night', type: 'Movie' }]);
  const orders = (await get(`/api/orders?page=1&pageSize=25&order=${movieOnly.id}`, token)).json.orders;
  assert.deepEqual(orders, [], 'an order with nothing in the filter isn\'t shown');
});
