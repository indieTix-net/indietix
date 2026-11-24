import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';
import { installFakeCatalog } from './helpers/fakeSquareCatalog.mjs';

// ---- SHOWING SALES SYNC: showtimes follow refunds, cancels, deletes and seat changes ----
// A sold-out showtime goes back on sale (a new showtime in Square, the item
// unarchived) when seats free up; a full one sells out when stop-when-full is
// on. The ticket change itself never fails because of Square.

let ctx;
let square;

before(async () => {
  ctx = await startTestServer({ clientConfig: { SQUARE_LOCATION_ID: 'LOC123' } });
});
after(async () => { await stopTestServer(ctx); });

const FUTURE = ['Fri 06-07-2030 7:00 PM (Main Auditorium)', 'Sat 06-08-2030 9:30 PM (Little Theater)'];
let eventId;
let showingIds; // [first, second], in FUTURE order

const call = (method, path, body) => ctx.request(method, path, { token: ctx.clientToken, body });
const setEnforce = (on) => ctx.pgClient.query(
  `UPDATE "Client" SET "configuration" = ("configuration"::jsonb || jsonb_build_object('ENFORCE_CAPACITY', $1::text))::json`, [on ? 'true' : 'false']);
const showing = async (id) => (await ctx.pgClient.query(`SELECT "Status", "SoldOutAt" FROM "Showing" WHERE "ID" = $1`, [id])).rows[0];
const liveModifiers = async (id) => (await ctx.pgClient.query(
  `SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "DeletedAt" IS NULL`, [id])).rows.map((r) => r.ExternalID);
const squareLabels = () => square.objects.get('MOCK_MODIFIER_LIST_ID').modifier_list_data.modifiers.map((m) => m.modifier_data.name);

// An order with one ticket for the first showtime (by its original Square
// modifier, the way getSquareOrders' older tickets are matched).
async function orderWithTicket(n, modifierId = 'MOCK_MOD_0') {
  const order = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID", "EmailAddress", "FirstName", "LastName", "Status", "OrderMetaData") VALUES ($1, 'b@example.com', 'B', 'Uyer', 'Valid', '{}') RETURNING "ID"`,
    [`SYNC-ORDER-${n}`]);
  const ticket = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "ProductMetadata", "Status")
     VALUES ($1, '2030-09-01', '2030-06-07 19:00:00', 'Sync Movie', 'LOC123', 'Movie', $2, 'MOCK_VAR_1', $3, 'valid') RETURNING "ID"`,
    [`QR-SYNC-${n}`, FUTURE[0], JSON.stringify({ modifiers: [{ catalog_object_id: modifierId, name: FUTURE[0] }] })]);
  await ctx.pgClient.query(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`, [ticket.rows[0].ID, order.rows[0].ID]);
  return { orderId: order.rows[0].ID, ticketId: ticket.rows[0].ID };
}

// Fill the first showtime (capacity 1, its one ticket sold) and let the seat
// change sell it out.
async function soldOutFirstShowtime() {
  const sale = await orderWithTicket(1);
  await setEnforce(true);
  const { status, json } = await call('PUT', `/api/events/${eventId}/showings/${showingIds[0]}/seats`, { capacity: '1', heldSeats: '0' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.sync.action, 'sold_out');
  assert.equal((await showing(showingIds[0])).Status, 'sold_out');
  assert.deepEqual(squareLabels(), [FUTURE[1]], 'the full showtime left Square');
  return sale;
}

beforeEach(async () => {
  resetSquareHandlers();
  square = installFakeCatalog(squareHandlers);
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event', 'QRCodeProductToOrder', 'QRCodeProduct', 'Order']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`);
  }
  await setEnforce(false);
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', {
    token: ctx.clientToken, body: { movieData: { title: 'Sync Movie', description: 'x', showtimes: FUTURE }, createCalendarEvents: false }
  });
  assert.equal(status, 200, JSON.stringify(json));
  eventId = json.eventId;
  showingIds = (await ctx.pgClient.query(`SELECT "ID" FROM "Showing" WHERE "EventID" = $1 ORDER BY "StartsAt"`, [eventId])).rows.map((r) => r.ID);
  square.calls.length = 0;
});

test('seats: lowering capacity to what\'s sold sells the showtime out when stop-when-full is on; raising it puts it back on sale', async () => {
  await soldOutFirstShowtime();
  const { json } = await call('PUT', `/api/events/${eventId}/showings/${showingIds[0]}/seats`, { capacity: '2', heldSeats: '0' });
  assert.equal(json.sync.action, 'reopened');
  const s = await showing(showingIds[0]);
  assert.deepEqual([s.Status, s.SoldOutAt], ['on_sale', null]);
  assert.deepEqual(squareLabels(), [FUTURE[1], FUTURE[0]], 'a new showtime with the same text is back in Square');
  const [modifierId] = await liveModifiers(showingIds[0]);
  assert.match(modifierId, /^NEW_MOD_/, 'linked to the new Square showtime');
});

test('seats: with stop-when-full off, a full showtime stays on sale', async () => {
  await orderWithTicket(1);
  const { json } = await call('PUT', `/api/events/${eventId}/showings/${showingIds[0]}/seats`, { capacity: '1', heldSeats: '0' });
  assert.equal(json.sync.action, 'none');
  assert.equal((await showing(showingIds[0])).Status, 'on_sale');
  assert.equal(squareLabels().length, 2);
});

test('cancelling an order frees its seat: the sold-out showtime goes back on sale', async () => {
  const { orderId } = await soldOutFirstShowtime();
  const { status, json } = await call('POST', `/api/orders/${orderId}/cancel`, { cancelledBy: 'staff', cancelReason: 'test' });
  assert.equal(status, 200);
  assert.deepEqual(json.showtimes.map((s) => [s.showingId, s.action]), [[showingIds[0], 'reopened']]);
  assert.equal((await showing(showingIds[0])).Status, 'on_sale');
  assert.ok(squareLabels().includes(FUTURE[0]));
});

test('deleting an order frees its seat too (deleted tickets no longer count as sold)', async () => {
  const { orderId } = await soldOutFirstShowtime();
  const { status, json } = await call('POST', `/api/orders/${orderId}/delete`, { deletedBy: 'staff', deleteReason: 'test' });
  assert.equal(status, 200);
  assert.equal(json.showtimes[0].action, 'reopened');
  const { json: ev } = await call('GET', `/api/events/${eventId}`);
  assert.equal(ev.event.showings.find((s) => s.id === showingIds[0]).sold, 0);
});

test('refunding an order (through Square) frees its seat', async () => {
  const { orderId } = await soldOutFirstShowtime();
  const { status, json } = await call('POST', `/api/orders/${orderId}/refund`, { paymentId: 'sq-payment-1', refundedBy: 'staff', refundReason: 'test' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.showtimes[0].action, 'reopened');
  assert.equal((await showing(showingIds[0])).Status, 'on_sale');
});

test('the last upcoming showtime: selling out archives the item, a refund unarchives it, and un-refunding sells it out again', async () => {
  // Cancel the second showtime so the first is the only upcoming one.
  assert.equal((await call('POST', `/api/events/${eventId}/showings/${showingIds[1]}/cancel`)).status, 200);
  const { ticketId } = await orderWithTicket(1);
  await setEnforce(true);
  const seats = await call('PUT', `/api/events/${eventId}/showings/${showingIds[0]}/seats`, { capacity: '1', heldSeats: '0' });
  assert.deepEqual([seats.json.sync.action, seats.json.sync.archived], ['sold_out', true]);
  assert.equal(square.objects.get('MOCK_ITEM_ID').item_data.is_archived, true);

  const refund = await call('POST', `/api/products/${ticketId}/refund`);
  assert.equal(refund.status, 200);
  assert.deepEqual([refund.json.newStatus, refund.json.showtimes[0].action, refund.json.showtimes[0].unarchived], ['refunded', 'reopened', true]);
  const item = square.objects.get('MOCK_ITEM_ID');
  assert.equal(item.item_data.is_archived, false);
  assert.ok(Object.keys(item.custom_attribute_values || {}).length > 0, 'UseQRCode and the other attributes survive the round trip');
  assert.equal((await ctx.pgClient.query(`SELECT "Status" FROM "Event" WHERE "ID" = $1`, [eventId])).rows[0].Status, 'active');

  const unrefund = await call('POST', `/api/products/${ticketId}/refund`);
  assert.deepEqual([unrefund.json.newStatus, unrefund.json.showtimes[0].action, unrefund.json.showtimes[0].archived], ['valid', 'sold_out', true]);
  assert.equal(square.objects.get('MOCK_ITEM_ID').item_data.is_archived, true);
});

test('a reopen that Square refuses: the refund still succeeds, the showtime stays sold out, nothing is left half-made', async () => {
  const { ticketId } = await soldOutFirstShowtime();
  square.failNext = 'upsert';
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  let refund;
  try {
    refund = await call('POST', `/api/products/${ticketId}/refund`);
  } finally {
    console.error = original;
  }
  assert.equal(refund.status, 200);
  assert.equal(refund.json.newStatus, 'refunded');
  assert.ok(refund.json.showtimes[0].error);
  assert.ok(errors.some((e) => e.includes('SHOWING_SYNC_FAILED')), 'logged for the alarm');
  assert.equal((await showing(showingIds[0])).Status, 'sold_out');
  assert.deepEqual(await liveModifiers(showingIds[0]), []);
  assert.deepEqual(squareLabels(), [FUTURE[1]]);
});

test('changes that don\'t touch a full or sold-out showtime do nothing in Square', async () => {
  const { ticketId } = await orderWithTicket(1);
  await setEnforce(true);
  const refund = await call('POST', `/api/products/${ticketId}/refund`);
  assert.deepEqual(refund.json.showtimes.map((s) => s.action), ['none'], 'no capacity on this showtime');
  assert.equal(square.calls.filter((c) => c.op !== 'get').length, 0);
});

test('a ticket for a showtime IndieTix doesn\'t know changes nothing', async () => {
  const { ticketId } = await orderWithTicket(1, 'SOME_OTHER_MODIFIER');
  const refund = await call('POST', `/api/products/${ticketId}/refund`);
  assert.equal(refund.status, 200);
  assert.deepEqual(refund.json.showtimes, []);
  assert.equal(square.calls.length, 0);
});
