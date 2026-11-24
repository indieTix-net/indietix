import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

// ---- DASHBOARD FROM INDIETIX'S OWN SHOWINGS ----
// Today's Dashboard reads the venue's Showing rows for the day (any day, past
// included), adds Square showtimes IndieTix doesn't know for today and later,
// and falls back to the day's tickets when there are neither.

let ctx;
before(async () => {
  ctx = await startTestServer({ clientConfig: { VENUE_TIMEZONE: 'America/Chicago' } });
});
after(async () => { await stopTestServer(ctx); });

let squareCalls;
beforeEach(async () => {
  resetSquareHandlers();
  squareCalls = 0;
  // A past day must not ask Square at all.
  squareHandlers.searchCatalog = async () => { squareCalls++; return { ok: true, status: 200, json: async () => ({ objects: [] }) }; };
  for (const t of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event', 'QRCodeProductToOrder', 'QRCodeProduct']) {
    await ctx.pgClient.query(`DELETE FROM "${t}"`);
  }
});

const PAST = '2025-03-14';
const FUTURE = '2030-01-06';

async function event(title, { description = 'Runtime: 101 min', itemId = `ITEM-${title}` } = {}) {
  const id = (await ctx.pgClient.query(
    `INSERT INTO "Event" ("Kind", "Title", "Description", "Status") VALUES ('movie', $1, $2, 'active') RETURNING "ID"`, [title, description])).rows[0].ID;
  await ctx.pgClient.query(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('event', $1, 'square', 'ITEM', $2)`, [id, itemId]);
  return id;
}
async function showing(eventId, startsAt, { venue = 'Main Auditorium', descriptors = '', capacity = null, held = 0, status = 'expired', modifierId = null } = {}) {
  const [d, t] = startsAt.split(' ');
  const [y, m, day] = d.split('-');
  let [hh, mm] = t.split(':').map(Number);
  const label = `Fri ${m}-${day}-${y} ${(hh % 12) || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'} (${venue})`;
  const id = (await ctx.pgClient.query(
    `INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Descriptors", "Label", "Capacity", "HeldSeats", "Status") VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING "ID"`,
    [eventId, startsAt, venue, descriptors, label, capacity, held, status])).rows[0].ID;
  if (modifierId) {
    await ctx.pgClient.query(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID", "DeletedAt") VALUES ('showing', $1, 'square', 'MODIFIER', $2, now())`, [id, modifierId]);
  }
  return id;
}
async function ticket({ name, date, showingId = null, modifierId = null, status = 'valid', checkedIn = false }) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "CheckedIn", "Status", "ProductMetadata", "ShowingID")
     VALUES ($1, '2099-01-01', $2, $3, 'Main', 'Movie', 'details', 'ITEM', $4, $5, $6, $7)`,
    [`QR-${Math.random()}`, date, name, checkedIn, status, JSON.stringify({ modifiers: modifierId ? [{ catalog_object_id: modifierId }] : [] }), showingId]);
}
const dashboard = (date, token = ctx.clientToken) => ctx.request('GET', `/api/dashboard/today?date=${date}`, { token });

test('a past day comes from IndieTix\'s showings: every showing (even unsold), counts by ShowingID or stored showtime id, seats left, no Square call', async () => {
  const film = await event('The Long Night');
  const early = await showing(film, `${PAST} 16:00:00`, { capacity: 100, held: 4, descriptors: 'Closed Caption' });
  const late = await showing(film, `${PAST} 19:30:00`, { capacity: 100, modifierId: 'MOD-LATE' });
  await showing(film, `${PAST} 21:45:00`); // nothing sold, no limit
  await showing(film, `${PAST} 23:00:00`, { status: 'cancelled' });
  await ticket({ name: 'The Long Night', date: `${PAST} 16:00:00`, showingId: early, checkedIn: true });
  await ticket({ name: 'The Long Night', date: `${PAST} 16:00:00`, showingId: early });
  await ticket({ name: 'The Long Night', date: `${PAST} 16:00:00`, showingId: early, status: 'refunded' });
  // An older ticket from before ShowingID: matched by its stored showtime id.
  await ticket({ name: 'The Long Night', date: `${PAST} 19:30:00`, modifierId: 'MOD-LATE', checkedIn: true });

  const { status, json } = await dashboard(PAST);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.source, 'showings');
  assert.equal(squareCalls, 0, 'a past day doesn\'t ask Square');
  assert.deepEqual(json.events.map((e) => [e.displayTime, e.ticketsSold, e.checkedIn, e.capacity, e.available]), [
    ['4:00 PM', 2, 1, 100, 94],
    ['7:30 PM', 1, 1, 100, 99],
    ['9:45 PM', 0, 0, null, null]
  ], 'the cancelled showing is left out; refunded tickets don\'t count');
  const first = json.events[0];
  assert.deepEqual([first.title, first.location, first.runtime, first.descriptors, first.matchedBy, first.itemId], ['The Long Night', 'Main Auditorium', 101, ['Closed Caption'], 'showing', 'ITEM-The Long Night']);
  assert.equal(json.events[1].modifierId, 'MOD-LATE');
});

test('today and later: IndieTix\'s showings plus Square showtimes it doesn\'t have, in time order, with no duplicates', async () => {
  const film = await event('Known Film');
  const known = await showing(film, `${FUTURE} 19:00:00`, { capacity: 50, status: 'on_sale', modifierId: 'MOD-KNOWN' });
  await ticket({ name: 'Known Film', date: `${FUTURE} 19:00:00`, showingId: known });
  await ticket({ name: 'Square Only', date: `${FUTURE} 14:30:00`, modifierId: 'MOD-SQ-ONLY' });
  squareHandlers.searchCatalog = async () => {
    squareCalls++;
    return { ok: true, status: 200, json: async () => ({
      objects: [
        { type: 'ITEM', id: 'ITEM-K', item_data: { name: 'Known Film', description: '', modifier_list_info: [{ modifier_list_id: 'ML-K' }] } },
        { type: 'ITEM', id: 'ITEM-S', item_data: { name: 'Square Only', description: '', modifier_list_info: [{ modifier_list_id: 'ML-S' }] } }
      ],
      related_objects: [
        { type: 'MODIFIER_LIST', id: 'ML-K', modifier_list_data: { modifiers: [{ id: 'MOD-KNOWN', modifier_data: { name: 'Sun 01-06-2030 7:00 PM (Main Auditorium)' } }] } },
        { type: 'MODIFIER_LIST', id: 'ML-S', modifier_list_data: { modifiers: [{ id: 'MOD-SQ-ONLY', modifier_data: { name: 'Sun 01-06-2030 2:30 PM (Main Auditorium)' } }] } }
      ]
    }) };
  };
  const { status, json } = await dashboard(FUTURE);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.source, 'showings+square');
  assert.deepEqual(json.events.map((e) => [e.title, e.displayTime, e.ticketsSold, e.matchedBy]), [
    ['Square Only', '2:30 PM', 1, 'modifier_id'],
    ['Known Film', '7:00 PM', 1, 'showing']
  ]);
  assert.equal(json.events[1].available, 49);
});

test('a sold-out showing says so', async () => {
  const film = await event('Full House');
  const s = await showing(film, `${FUTURE} 20:00:00`, { capacity: 1, status: 'sold_out' });
  await ticket({ name: 'Full House', date: `${FUTURE} 20:00:00`, showingId: s });
  const { json } = await dashboard(FUTURE);
  assert.deepEqual([json.events[0].status, json.events[0].available], ['sold_out', 0]);
});

test('a day from before the venue had its own showings comes from its tickets (was blank)', async () => {
  await ticket({ name: 'Old Favorite', date: '2024-06-01 19:00:00', modifierId: 'MOD-GONE', checkedIn: true });
  const { status, json } = await dashboard('2024-06-01');
  assert.equal(status, 200);
  assert.equal(json.source, 'tickets');
  assert.equal(squareCalls, 0);
  assert.deepEqual(json.events.map((e) => [e.title, e.ticketsSold, e.checkedIn]), [['Old Favorite', 1, 1]]);
});

test('a staff login\'s data filter: only showings with its tickets, counts are its tickets, and no seats left', async () => {
  const wanted = await event('Wanted Show');
  const other = await event('Other Show');
  const a = await showing(wanted, `${PAST} 18:00:00`, { capacity: 80 });
  const b = await showing(other, `${PAST} 20:00:00`, { capacity: 80 });
  await showing(wanted, `${PAST} 22:00:00`, { capacity: 80 }); // none of its tickets
  await ticket({ name: 'Wanted Show', date: `${PAST} 18:00:00`, showingId: a });
  await ticket({ name: 'Other Show', date: `${PAST} 20:00:00`, showingId: b });
  const { token } = await ctx.insertUser({ username: 'dashfilter', dataFilter: { datafilters: [{ event: 'Wanted Show' }] } });
  const { json } = await dashboard(PAST, token);
  assert.equal(json.filtered, true);
  assert.deepEqual(json.events.map((e) => [e.title, e.ticketsSold]), [['Wanted Show', 1]]);
  assert.equal(json.events[0].capacity, undefined, 'seats left would be wrong from a filtered count');
});

// Last: drops the tables.
test('a venue database without the native event tables still gets its day from tickets', async () => {
  await ticket({ name: 'Plain Venue Film', date: `${PAST} 19:00:00` });
  for (const t of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event']) await ctx.pgClient.query(`DROP TABLE "${t}"`);
  const { status, json } = await dashboard(PAST);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.source, 'tickets');
  assert.equal(json.events[0].title, 'Plain Venue Film');
});
