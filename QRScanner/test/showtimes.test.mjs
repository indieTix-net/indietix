import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';
import { roomCapacity, validateRoomCapacity } from '../src/utils/native-events.mjs';
import { installFakeCatalog } from './helpers/fakeSquareCatalog.mjs';

// ---- SHOWTIME MANAGEMENT: the Showtimes page's API ----
// A tiny fake Square catalog records what each call did to the item, its
// showtime list and its showtimes, so the tests can check Square and
// IndieTix end up agreeing.

let ctx;
let square; // { objects: Map, calls: [] }

before(async () => {
  ctx = await startTestServer({
    clientConfig: { SQUARE_LOCATION_ID: 'LOC123', ROOM_CAPACITY: { 'Main Auditorium': 300, 'Little Theater': 90 } }
  });
});
after(async () => { await stopTestServer(ctx); });

const FUTURE = ['Fri 06-07-2030 7:00 PM (Main Auditorium)', 'Sat 06-08-2030 9:30 PM (Little Theater, 21+)'];
let eventId;

beforeEach(async () => {
  resetSquareHandlers();
  square = installFakeCatalog(squareHandlers);
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event', 'QRCodeProductToOrder', 'QRCodeProduct']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`);
  }
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', {
    token: ctx.clientToken, body: { movieData: { title: 'Showtime Test Movie', description: 'x', showtimes: FUTURE }, createCalendarEvents: false }
  });
  assert.equal(status, 200, JSON.stringify(json));
  eventId = json.eventId;
  square.calls.length = 0;
});

const call = (method, path, body, token = ctx.clientToken) => ctx.request(method, path, { token, body });
const showings = async () => (await call('GET', `/api/events/${eventId}`)).json.event.showings;
async function sellTicket(modifierId, status = 'valid') {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "ProductMetadata", "Status")
     VALUES ($1, '2030-09-01', '2030-06-07 19:00:00', 'Showtime Test Movie', 'LOC123', 'Movie', $4, 'MOCK_VAR_1', $2, $3)`,
    [`QR-${Math.random()}`, JSON.stringify({ modifiers: [{ catalog_object_id: modifierId, name: FUTURE[0] }] }), status, FUTURE[0]]);
}

// ---- room capacity ----

test('room seats: Add Movie starts each showing at its room\'s seats from ROOM_CAPACITY; no entry = no limit', async () => {
  const list = await showings();
  assert.deepEqual(list.map((s) => [s.venue, s.capacity, s.heldSeats, s.available]), [['Main Auditorium', 300, 0, 300], ['Little Theater', 90, 0, 90]]);
  assert.equal(roomCapacity({ 'main auditorium ': '300' }, 'Main Auditorium'), 300, 'room names match ignoring case and spaces');
  assert.equal(roomCapacity({ 'Main Auditorium': '' }, 'Main Auditorium'), null);
  assert.equal(roomCapacity({}, 'Spacement'), null);
  assert.equal(validateRoomCapacity({ A: 10, B: '' }), null);
  assert.match(validateRoomCapacity({ A: 'ten' }), /whole number/);
});

// ---- listing ----

test('GET /api/events lists the event with its upcoming showtimes', async () => {
  const { status, json } = await call('GET', '/api/events');
  assert.equal(status, 200);
  assert.deepEqual(json.events.map((e) => [e.id, e.title, e.upcoming, e.nextStartsAt]), [[eventId, 'Showtime Test Movie', 2, '2030-06-07 19:00:00']]);
});

test('the Showtimes API needs edit permission (a door-only user is refused)', async () => {
  const { token } = await ctx.insertUser({ username: 'dooronly', permissions: { view: false, edit: false, checkIn: true } });
  assert.equal((await call('GET', '/api/events', undefined, token)).status, 403);
  assert.equal((await call('POST', `/api/events/${eventId}/showings`, { label: 'Sun 06-09-2030 7:00 PM (Main Auditorium)' }, token)).status, 403);
});

// ---- add ----

test('add: a new showtime is added to the item\'s Square showtime list and saved, with the room\'s seats', async () => {
  const label = 'Sun 06-09-2030 3:00 PM (Little Theater)';
  const { status, json } = await call('POST', `/api/events/${eventId}/showings`, { label });
  assert.equal(status, 200, JSON.stringify(json));
  const created = square.calls.find((c) => c.op === 'upsert' && c.type === 'MODIFIER');
  assert.equal(created.object.modifier_data.name, label);
  assert.equal(created.object.modifier_data.modifier_list_id, 'MOCK_MODIFIER_LIST_ID');
  assert.equal(created.object.modifier_data.ordinal, 3, 'after the two existing showtimes');
  const added = json.event.showings.find((s) => s.label === label);
  assert.deepEqual([added.startsAt, added.venue, added.capacity, added.status], ['2030-06-09 15:00:00', 'Little Theater', 90, 'on_sale']);
  const link = await ctx.pgClient.query(`SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" = $1`, [added.id]);
  assert.deepEqual(link.rows, [{ ExternalID: json.modifierId }]);
});

test('add: capacity and held seats typed on the page override the room\'s seats', async () => {
  const { json } = await call('POST', `/api/events/${eventId}/showings`, { label: 'Sun 06-09-2030 3:00 PM (Main Auditorium)', capacity: '40', heldSeats: '4' });
  const added = json.event.showings.find((s) => s.label.startsWith('Sun 06-09-2030'));
  assert.deepEqual([added.capacity, added.heldSeats, added.available], [40, 4, 36]);
  const blank = await call('POST', `/api/events/${eventId}/showings`, { label: 'Mon 06-10-2030 3:00 PM (Main Auditorium)', capacity: '', heldSeats: '' });
  assert.equal(blank.json.event.showings.find((s) => s.label.startsWith('Mon')).capacity, null, 'blank = no limit');
});

test('add: refused, with nothing created in Square, for a bad label, a past time, a duplicate, or bad seats', async () => {
  const cases = [
    [{ label: 'soon-ish' }, 400, /not understood/],
    [{ label: 'Mon 01-05-2026 7:00 PM (Main Auditorium)' }, 400, /in the past/],
    [{ label: FUTURE[0] }, 409, /already has that showtime/],
    [{ label: 'Sun 06-09-2030 3:00 PM (Main Auditorium)', capacity: '10', heldSeats: '11' }, 400, /Held seats/],
    [{ label: 'Sun 06-09-2030 3:00 PM (Main Auditorium)', capacity: 'many' }, 400, /Capacity/]
  ];
  for (const [body, status, message] of cases) {
    const response = await call('POST', `/api/events/${eventId}/showings`, body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.match(response.json.error, message);
  }
  assert.equal(square.calls.filter((c) => c.op === 'upsert').length, 0);
  assert.equal((await showings()).length, 2);
});

test('add: if Square fails, nothing is saved', async () => {
  square.failNext = 'upsert';
  const { status } = await call('POST', `/api/events/${eventId}/showings`, { label: 'Sun 06-09-2030 3:00 PM (Main Auditorium)' });
  assert.equal(status, 500);
  assert.equal((await showings()).length, 2);
});

test('add: an unknown event is a 404', async () => {
  assert.equal((await call('POST', `/api/events/999999/showings`, { label: 'Sun 06-09-2030 3:00 PM (Main Auditorium)' })).status, 404);
  assert.equal((await call('GET', '/api/events/abc')).status, 404);
});

// ---- edit ----

test('edit: changing a showtime with no tickets sold renames it in Square (at its current version) and updates IndieTix', async () => {
  const [first] = await showings();
  const label = 'Fri 06-07-2030 8:15 PM (Little Theater, 21+)';
  const { status, json } = await call('PUT', `/api/events/${eventId}/showings/${first.id}`, { label });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(square.objects.get('MOCK_MOD_0').modifier_data.name, label);
  assert.equal(square.objects.get('MOCK_MOD_0').version, 2);
  const edited = json.event.showings.find((s) => s.id === first.id);
  assert.deepEqual([edited.label, edited.startsAt, edited.venue, edited.descriptors], [label, '2030-06-07 20:15:00', 'Little Theater', '21+']);
});

test('edit: refused once a ticket is sold (it shows the current time); refunded tickets don\'t count', async () => {
  const [first] = await showings();
  await sellTicket('MOCK_MOD_0', 'refunded');
  const okEdit = await call('PUT', `/api/events/${eventId}/showings/${first.id}`, { label: 'Fri 06-07-2030 8:00 PM (Main Auditorium)' });
  assert.equal(okEdit.status, 200, 'only a refunded ticket: still changeable');
  await sellTicket('MOCK_MOD_0');
  const { status, json } = await call('PUT', `/api/events/${eventId}/showings/${first.id}`, { label: 'Fri 06-07-2030 9:00 PM (Main Auditorium)' });
  assert.equal(status, 409);
  assert.match(json.error, /1 ticket has been sold/);
  assert.equal(square.objects.get('MOCK_MOD_0').modifier_data.name, 'Fri 06-07-2030 8:00 PM (Main Auditorium)');
});

// ---- seats ----

test('seats: capacity and held seats can change after sales, but never below what\'s sold', async () => {
  const [first] = await showings();
  await sellTicket('MOCK_MOD_0'); await sellTicket('MOCK_MOD_0'); await sellTicket('MOCK_MOD_0');
  const path = `/api/events/${eventId}/showings/${first.id}/seats`;
  const set = await call('PUT', path, { capacity: '10', heldSeats: '2' });
  assert.equal(set.status, 200);
  const row = set.json.event.showings.find((s) => s.id === first.id);
  assert.deepEqual([row.sold, row.capacity, row.heldSeats, row.available], [3, 10, 2, 5]);
  assert.equal((await call('PUT', path, { capacity: '4', heldSeats: '2' })).status, 409, '4 - 2 < 3 sold');
  assert.equal((await call('PUT', path, { capacity: '', heldSeats: '3' })).status, 400, 'held seats need a capacity');
  assert.equal((await call('PUT', path, { capacity: '', heldSeats: '0' })).json.event.showings.find((s) => s.id === first.id).capacity, null);
  assert.equal(square.calls.length, 0, 'seats are IndieTix-only; Square isn\'t touched');
});

// ---- cancel ----

test('cancel: the showtime is removed from Square and marked cancelled; sold tickets are counted, not refunded', async () => {
  const [first] = await showings();
  await sellTicket('MOCK_MOD_0'); await sellTicket('MOCK_MOD_0');
  const { status, json } = await call('POST', `/api/events/${eventId}/showings/${first.id}/cancel`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.soldTickets, 2);
  assert.equal(json.archived, false, 'another showtime is still upcoming');
  assert.ok(square.calls.some((c) => c.op === 'delete' && c.id === 'MOCK_MOD_0'));
  assert.equal(json.event.showings.find((s) => s.id === first.id).status, 'cancelled');
  const link = await ctx.pgClient.query(`SELECT "DeletedAt" IS NOT NULL AS gone, "DeletedReason" FROM "ExternalCatalogLink" WHERE "ExternalID" = 'MOCK_MOD_0'`);
  assert.deepEqual(link.rows, [{ gone: true, DeletedReason: 'cancelled' }]);
  const tickets = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct"`);
  assert.deepEqual(tickets.rows.map((r) => r.Status), ['valid', 'valid']);
  assert.equal((await call('POST', `/api/events/${eventId}/showings/${first.id}/cancel`)).status, 409, 'already cancelled');
});

test('cancel: a showtime Square already removed (e.g. the nightly expiry) still cancels', async () => {
  const [first] = await showings();
  square.objects.delete('MOCK_MOD_0');
  const { status } = await call('POST', `/api/events/${eventId}/showings/${first.id}/cancel`);
  assert.equal(status, 200);
});

test('cancel: if Square fails, the showtime stays on sale in IndieTix too', async () => {
  const [first] = await showings();
  square.failNext = 'delete';
  assert.equal((await call('POST', `/api/events/${eventId}/showings/${first.id}/cancel`)).status, 500);
  assert.equal((await showings()).find((s) => s.id === first.id).status, 'on_sale');
});

test('cancel the last upcoming showtime: the item is archived in Square; adding one brings it back with everything intact', async () => {
  const [first, second] = await showings();
  await call('POST', `/api/events/${eventId}/showings/${first.id}/cancel`);
  const { json } = await call('POST', `/api/events/${eventId}/showings/${second.id}/cancel`);
  assert.equal(json.archived, true);
  assert.equal(square.objects.get('MOCK_ITEM_ID').item_data.is_archived, true);
  assert.equal(json.event.status, 'archived');
  assert.deepEqual((await call('GET', '/api/events')).json.events, [], 'archived events are hidden by default');
  assert.equal((await call('GET', '/api/events?archived=1')).json.events.length, 1);

  const added = await call('POST', `/api/events/${eventId}/showings`, { label: 'Sun 06-09-2030 3:00 PM (Main Auditorium)' });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.unarchived, true);
  const item = square.objects.get('MOCK_ITEM_ID');
  assert.equal(item.item_data.is_archived, false);
  assert.ok(item.custom_attribute_values && Object.keys(item.custom_attribute_values).length > 0, 'custom attributes (UseQRCode) survive');
  assert.equal(added.json.event.status, 'active');
});

// Last: drops the tables.
test('a venue database without the native event tables gets a clear 503', async () => {
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event']) await ctx.pgClient.query(`DROP TABLE "${table}"`);
  const { status, json } = await call('GET', '/api/events');
  assert.equal(status, 503);
  assert.match(json.error, /not set up for this venue yet/);
});
