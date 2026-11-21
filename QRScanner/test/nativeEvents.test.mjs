import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';
import { parseShowtimeLabel, storablePosterUrl } from '../src/utils/native-events.mjs';

// ---- NATIVE EVENTS (step 2): Add Movie / Add Event keep IndieTix's own copy ----
// The draft is written before Square is touched, linked to the Square item,
// showtime modifiers and ticket variations once they exist, and removed if
// Square fails. See NATIVE_EVENTS_PLAN.md.

let ctx;

before(async () => { ctx = await startTestServer({ clientConfig: { SQUARE_LOCATION_ID: 'LOC123' } }); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`).catch(() => {});
  }
});

const SHOWTIMES = ['Fri 11-20-2026 6:00 PM (Main Auditorium)', 'Sat 11-21-2026 9:30 PM (Little Theater, 21+, Open Caption)'];

function movieBody(overrides = {}) {
  return { movieData: { title: 'Native Test Movie', description: 'A test movie', showtimes: SHOWTIMES, ...overrides }, createCalendarEvents: false };
}
function eventBody(overrides = {}) {
  return { eventData: { title: 'Native Test Show', description: 'A live show', showtimes: ['Sun 11-22-2026 7:00 PM (Spacement)'], ...overrides }, createCalendarEvents: false };
}
const createMovie = (body = movieBody()) => ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body });
const createEvent = (body = eventBody()) => ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body });
const rows = async (sql) => (await ctx.pgClient.query(sql)).rows;
const count = async (table) => (await rows(`SELECT COUNT(*)::int AS n FROM "${table}"`))[0].n;

function countSquareCreates() {
  const calls = [];
  const original = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => { calls.push(body.object.type); return original(body); };
  return calls;
}

// ---- parseShowtimeLabel ----

test('parseShowtimeLabel: reads the Add Movie/Event format into Chicago wall-clock time, room and descriptors', () => {
  assert.deepEqual(parseShowtimeLabel('Sat 11-21-2026 9:30 PM (Little Theater, 21+, Open Caption)'), {
    startsAt: '2026-11-21 21:30:00', venue: 'Little Theater', descriptors: ['21+', 'Open Caption'], label: 'Sat 11-21-2026 9:30 PM (Little Theater, 21+, Open Caption)'
  });
  assert.equal(parseShowtimeLabel('Sun 01-18-2026 12:00 AM (Main)').startsAt, '2026-01-18 00:00:00');
  assert.equal(parseShowtimeLabel('Sun 01-18-2026 12:15 PM (Main)').startsAt, '2026-01-18 12:15:00');
  assert.equal(parseShowtimeLabel('Sun 01-18-2026 7:00 PM').venue, 'Main', 'no room given: same default as getSquareOrders');
  assert.equal(parseShowtimeLabel('  Sun  01-18-2026 7:00 PM (Spacement) ').label, 'Sun 01-18-2026 7:00 PM (Spacement)');
});

test('parseShowtimeLabel: anything else is refused, not guessed', () => {
  for (const bad of ['', 'tomorrow at 7', 'Xyz 01-18-2026 7:00 PM (Main)', 'Sun 02-30-2026 7:00 PM (Main)',
    'Sun 13-01-2026 7:00 PM (Main)', 'Sun 01-18-2026 13:00 PM (Main)', 'Sun 01-18-2026 7:00 (Main)', 'Sun 2026-01-18 7:00 PM', null, 42]) {
    assert.equal(parseShowtimeLabel(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

test('parseShowtimeLabel: agrees with what getSquareOrders recorded for every real Liberty Hall showtime', () => {
  const dir = new URL('../../getSquareOrders/test/fixtures/liberty-hall/', import.meta.url);
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(new URL(file, dir)));
    for (const ticket of fx.expected.tickets) {
      const parsed = parseShowtimeLabel(ticket.ProductDetails);
      assert.ok(parsed, `${fx.shape}: "${ticket.ProductDetails}" parses`);
      assert.equal(parsed.startsAt, ticket.ProductDate, `${fx.shape}: showtime`);
      assert.equal(parsed.venue, ticket.ProductVenue, `${fx.shape}: room`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} recorded tickets`);
});

// ---- Add Movie ----

test('Add Movie: saves the event, ticket types and showings, linked to the Square item, modifiers and variations', async () => {
  const { status, json } = await createMovie();
  assert.equal(status, 200, JSON.stringify(json));
  assert.ok(Number.isInteger(json.eventId), 'response carries the IndieTix event id');

  const [event] = await rows(`SELECT * FROM "Event"`);
  assert.equal(event.ID, json.eventId);
  assert.equal(event.Kind, 'movie');
  assert.equal(event.Title, 'Native Test Movie');
  assert.equal(event.EventType, 'Movie');
  assert.equal(event.Status, 'active');
  assert.equal(event.CreatedBy, ctx.clientId);

  const ticketTypes = await rows(`SELECT "Name", "PriceCents" FROM "TicketType" ORDER BY "SortOrder"`);
  assert.deepEqual(ticketTypes, [{ Name: 'Child', PriceCents: 1000 }, { Name: 'Adult', PriceCents: 1250 }, { Name: 'Senior', PriceCents: 1100 }]);

  const showings = await rows(`SELECT "ID", "StartsAt"::text AS "StartsAt", "Venue", "Descriptors", "Label", "Status", "Capacity" FROM "Showing" ORDER BY "StartsAt"`);
  assert.deepEqual(showings.map(({ ID, ...s }) => s), [
    { StartsAt: '2026-11-20 18:00:00', Venue: 'Main Auditorium', Descriptors: '', Label: SHOWTIMES[0], Status: 'on_sale', Capacity: null },
    { StartsAt: '2026-11-21 21:30:00', Venue: 'Little Theater', Descriptors: '21+, Open Caption', Label: SHOWTIMES[1], Status: 'on_sale', Capacity: null }
  ]);

  const links = await rows(`SELECT "EntityType", "EntityID", "Provider", "ExternalType", "ExternalID" FROM "ExternalCatalogLink" ORDER BY "ID"`);
  const ticketTypeIds = (await rows(`SELECT "ID" FROM "TicketType" ORDER BY "SortOrder"`)).map((r) => r.ID);
  assert.deepEqual(links, [
    { EntityType: 'event', EntityID: event.ID, Provider: 'square', ExternalType: 'ITEM', ExternalID: 'MOCK_ITEM_ID' },
    { EntityType: 'event', EntityID: event.ID, Provider: 'square', ExternalType: 'MODIFIER_LIST', ExternalID: 'MOCK_MODIFIER_LIST_ID' },
    { EntityType: 'showing', EntityID: showings[0].ID, Provider: 'square', ExternalType: 'MODIFIER', ExternalID: 'MOCK_MOD_0' },
    { EntityType: 'showing', EntityID: showings[1].ID, Provider: 'square', ExternalType: 'MODIFIER', ExternalID: 'MOCK_MOD_1' },
    ...ticketTypeIds.map((id, i) => ({ EntityType: 'ticket_type', EntityID: id, Provider: 'square', ExternalType: 'ITEM_VARIATION', ExternalID: `MOCK_VAR_${i}` }))
  ]);
});

test('Add Movie: showtime modifiers are matched to showings by ordinal, even if Square lists them in another order', async () => {
  const original = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => {
    const response = await original(body);
    if (body.object.type !== 'MODIFIER_LIST') return response;
    const data = await response.json();
    data.catalog_object.modifier_list_data.modifiers.reverse();
    return { ok: true, status: 200, json: async () => data };
  };
  await createMovie();
  const linked = await rows(`SELECT s."Label", l."ExternalID" FROM "Showing" s JOIN "ExternalCatalogLink" l ON l."EntityType" = 'showing' AND l."EntityID" = s."ID" ORDER BY s."StartsAt"`);
  assert.deepEqual(linked, [{ Label: SHOWTIMES[0], ExternalID: 'MOCK_MOD_0' }, { Label: SHOWTIMES[1], ExternalID: 'MOCK_MOD_1' }]);
});

test('Add Movie: an unreadable showtime is refused before anything is created, in IndieTix or Square', async () => {
  const creates = countSquareCreates();
  const { status, json } = await createMovie(movieBody({ showtimes: [SHOWTIMES[0], 'next Tuesday-ish'] }));
  assert.equal(status, 400);
  assert.match(json.details, /next Tuesday-ish/);
  assert.deepEqual(creates, []);
  assert.equal(await count('Event'), 0);
});

test('Add Movie: when Square fails to create the item, the IndieTix draft is removed too', async () => {
  const original = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => body.object.type === 'ITEM'
    ? { ok: false, status: 500, text: async () => 'Square is down', json: async () => ({}) }
    : original(body);
  const { status } = await createMovie();
  assert.equal(status, 500);
  for (const table of ['Event', 'Showing', 'TicketType', 'ExternalCatalogLink']) assert.equal(await count(table), 0, `${table} empty`);
});

test('Add Movie: when Square fails on the showtime list, the IndieTix draft is removed too', async () => {
  squareHandlers.createCatalogObject = async () => ({ ok: false, status: 500, text: async () => 'Square is down', json: async () => ({}) });
  const { status } = await createMovie();
  assert.equal(status, 500);
  for (const table of ['Event', 'Showing', 'TicketType']) assert.equal(await count(table), 0, `${table} empty`);
});

test('Add Movie: if the links can\'t be saved, the Square item still stands and the message says IndieTix has no copy', async () => {
  const original = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => {
    const response = await original(body);
    if (body.object.type !== 'MODIFIER_LIST') return response;
    const data = await response.json();
    data.catalog_object.modifier_list_data.modifiers.pop(); // one modifier short
    return { ok: true, status: 200, json: async () => data };
  };
  const { status, json } = await createMovie();
  assert.equal(status, 200);
  assert.equal(json.itemId, 'MOCK_ITEM_ID');
  assert.equal(json.eventId, null);
  assert.match(json.message, /IndieTix could not save its own copy/);
  assert.equal(await count('Event'), 0, 'no half-linked draft left behind');
  assert.equal(await count('ExternalCatalogLink'), 0);
});

test('Add Movie: an uploaded poster (data: URL) is not copied into the database', async () => {
  await createMovie(movieBody({ posterUrl: 'data:image/png;base64,AAAA' }));
  assert.deepEqual(await rows(`SELECT "PosterUrl" FROM "Event"`), [{ PosterUrl: null }]);
});

test('storablePosterUrl: keeps web addresses, drops data: URLs and anything oversized', () => {
  assert.equal(storablePosterUrl('https://example.com/poster.jpg'), 'https://example.com/poster.jpg');
  assert.equal(storablePosterUrl('http://example.com/p.png'), 'http://example.com/p.png');
  assert.equal(storablePosterUrl('data:image/png;base64,AAAA'), null);
  assert.equal(storablePosterUrl('https://example.com/' + 'x'.repeat(2000)), null);
  assert.equal(storablePosterUrl(undefined), null);
});

// ---- Add Event ----

test('Add Event: saves a live event with the event ticket types, linked to Square', async () => {
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'MOCK_CAT_EVENTS', category_data: { name: 'Events' } }] }) });
  const { status, json } = await createEvent();
  assert.equal(status, 200, JSON.stringify(json));
  const [event] = await rows(`SELECT * FROM "Event"`);
  assert.equal(event.ID, json.eventId);
  assert.equal(event.Kind, 'event');
  assert.equal(event.EventType, 'Live');
  assert.equal(event.Status, 'active');
  assert.deepEqual(await rows(`SELECT "Name", "PriceCents" FROM "TicketType"`), [{ Name: 'Regular', PriceCents: 0 }]);
  assert.deepEqual(await rows(`SELECT "StartsAt"::text AS "StartsAt", "Venue" FROM "Showing"`), [{ StartsAt: '2026-11-22 19:00:00', Venue: 'Spacement' }]);
  assert.equal(await count('ExternalCatalogLink'), 4, 'item, showtime list, 1 showtime, 1 ticket type');
});

test('Add Event: an unreadable showtime is refused before anything is created', async () => {
  const creates = countSquareCreates();
  const { status } = await createEvent(eventBody({ showtimes: ['soon'] }));
  assert.equal(status, 400);
  assert.deepEqual(creates, []);
  assert.equal(await count('Event'), 0);
});

// Last: drops the tables.
test('a venue database without the native event tables still creates Square items exactly as before', async () => {
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event']) await ctx.pgClient.query(`DROP TABLE "${table}"`);
  const { status, json } = await createMovie();
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.itemId, 'MOCK_ITEM_ID');
  assert.equal(json.eventId, null);
  assert.doesNotMatch(json.message, /IndieTix could not save/);
});
