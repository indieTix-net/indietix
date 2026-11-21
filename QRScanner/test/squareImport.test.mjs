import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

// ---- SQUARE IMPORT: bring a venue's existing Square ticket items in (native events step 4) ----
// A small Square catalog shaped like Liberty Hall's: custom attributes carry
// their names, showtimes are modifiers in a "Show Time" list, ticket types
// are variations.

let ctx;
before(async () => {
  ctx = await startTestServer({
    clientConfig: {
      SQUARE_LOCATION_ID: 'LOC123', USE_QR_CODE: 'UseQRCode', EVENT_TYPE: 'EventType', DISTRIBUTOR_NAME: 'Distributor',
      MODIFIER_NAME_FILTER: 'Show Time', ROOM_CAPACITY: { 'Main Auditorium': 300 }
    }
  });
});
after(async () => { await stopTestServer(ctx); });

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const qr = { q: { name: 'UseQRCode', type: 'BOOLEAN', boolean_value: true } };
const selection = (name, def, uid) => ({ [name.toLowerCase()]: { name, type: 'SELECTION', custom_attribute_definition_id: def, selection_uid_values: [uid] } });
const variation = (id, name, cents) => ({ type: 'ITEM_VARIATION', id, item_variation_data: { name, price_money: { amount: cents, currency: 'USD' } } });
const item = (id, name, { attrs = qr, lists = [], variations = [], archived = false, varAttrs } = {}) => ({
  type: 'ITEM', id, custom_attribute_values: attrs,
  item_data: { name, is_archived: archived, description_plaintext: `${name} description`, modifier_list_info: lists.map((l) => ({ modifier_list_id: l })),
    variations: variations.map((v) => (varAttrs ? { ...v, custom_attribute_values: varAttrs } : v)) }
});
const modifierList = (id, name, modifiers) => ({ type: 'MODIFIER_LIST', id, modifier_list_data: { name,
  modifiers: modifiers.map(([mid, label], i) => ({ type: 'MODIFIER', id: mid, modifier_data: { name: label, ordinal: i + 1 } })) } });

const ITEMS = [
  item('ITEM-MOVIE', 'Naza (2026)', {
    attrs: { ...qr, ...selection('EventType', 'DEF-ET', 'SEL-MOVIE'), ...selection('Distributor', 'DEF-DIST', 'SEL-CINEMA') },
    lists: ['LIST-MOVIE'], variations: [variation('VAR-ADULT', 'Adult', 1250), variation('VAR-SENIOR', 'Senior', 1100)]
  }),
  item('ITEM-LIVE', 'Jazz Sunday', {
    attrs: { ...selection('EventType', 'DEF-ET', 'SEL-LIVE') }, varAttrs: qr, // UseQRCode on the variation, like some Liberty Hall items
    lists: ['LIST-LIVE'], variations: [variation('VAR-REGULAR', 'Regular', 1000)]
  }),
  item('ITEM-SODA', 'Canned Soda', { attrs: {}, variations: [variation('VAR-SODA', 'Can', 300)] }),
  item('ITEM-OLD', 'Old Movie', { archived: true, lists: ['LIST-OLD'], variations: [variation('VAR-OLD', 'Adult', 1250)] }),
  item('ITEM-NOLIST', 'No Showtimes', { variations: [variation('VAR-NL', 'Adult', 1250)] })
];
const LISTS = [
  modifierList('LIST-MOVIE', 'Show Time', [['MOD-1', 'Fri 11-20-2026 6:00 PM (Main Auditorium)'], ['MOD-2', 'Sat 06-08-2030 9:30 PM (Little Theater, 21+)'], ['MOD-BAD', 'Members night TBA']]),
  modifierList('LIST-LIVE', 'Show Time', [['MOD-LIVE', 'Sun 06-09-2030 7:00 PM (Spacement)']]),
  modifierList('LIST-OLD', 'Show Time', [['MOD-OLD', 'Fri 01-01-2021 7:00 PM (Main Auditorium)']])
];
const DEFINITIONS = [
  { type: 'CUSTOM_ATTRIBUTE_DEFINITION', id: 'DEF-ET', custom_attribute_definition_data: { name: 'EventType', selection_config: { allowed_selections: [{ uid: 'SEL-MOVIE', name: 'Movie' }, { uid: 'SEL-LIVE', name: 'Live' }] } } },
  { type: 'CUSTOM_ATTRIBUTE_DEFINITION', id: 'DEF-DIST', custom_attribute_definition_data: { name: 'Distributor', selection_config: { allowed_selections: [{ uid: 'SEL-CINEMA', name: 'Liberty Hall Cinema' }] } } }
];

let writes;
beforeEach(async () => {
  resetSquareHandlers();
  writes = [];
  // Two pages, to prove the cursor is followed.
  squareHandlers.listCatalogItems = async (cursor) => ok(cursor ? { objects: ITEMS.slice(2) } : { objects: ITEMS.slice(0, 2), cursor: 'PAGE2' });
  squareHandlers.listCatalogCustomAttributes = async () => ok({ objects: DEFINITIONS });
  squareHandlers.batchRetrieveCatalog = async (body) => ok({ objects: LISTS.filter((l) => body.object_ids.includes(l.id)) });
  squareHandlers.createCatalogObject = async (body) => { writes.push(body); return ok({}); };
  squareHandlers.deleteCatalogObject = async (id) => { writes.push({ delete: id }); return ok({}); };
  for (const t of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event', 'QRCodeProductToOrder', 'QRCodeProduct']) await ctx.pgClient.query(`DELETE FROM "${t}"`);
});

const runImport = (dryRun) => ctx.request('POST', '/api/events/import-from-square', { token: ctx.clientToken, body: { dryRun } });
const count = async (t) => (await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)).rows[0].n;
async function soldTicket(modifierId) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "ProductMetadata", "Status")
     VALUES ($1, '2030-01-01', '2026-11-20 18:00:00', 'Naza (2026)', 'LOC', 'Movie', 'x', 'VAR-ADULT', $2, 'valid')`,
    [`QR-${Math.random()}`, JSON.stringify({ catalog_object_id: 'VAR-ADULT', modifiers: [{ catalog_object_id: modifierId }] })]);
}

test('import preview: reports what would come in and writes nothing', async () => {
  const { status, json } = await runImport(true);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.dryRun, true);
  assert.deepEqual(json.imported.map((i) => [i.title, i.kind, i.showtimes]), [['Naza (2026)', 'movie', 2], ['Jazz Sunday', 'event', 1]]);
  assert.deepEqual(json.skipped.map((s) => s.title), ['No Showtimes']);
  assert.match(json.problems[0].problem, /Members night TBA/);
  assert.equal(await count('Event'), 0);
  assert.deepEqual(writes, [], 'Square is only read');
});

test('import: ticket items become events with ticket types, showings, room seats and links; concessions and archived items are left out', async () => {
  await soldTicket('MOD-1'); await soldTicket('MOD-1'); await soldTicket('MOD-OTHER');
  const { json } = await runImport(false);
  assert.equal(json.dryRun, false);
  assert.deepEqual(json.imported.map((i) => [i.title, i.ticketsLinked]), [['Naza (2026)', 2], ['Jazz Sunday', 0]]);

  const events = (await ctx.pgClient.query(`SELECT "ID", "Kind", "Title", "EventType", "Distributor", "Status", "CreatedBy" FROM "Event" ORDER BY "ID"`)).rows;
  assert.deepEqual(events.map(({ ID, ...e }) => e), [
    { Kind: 'movie', Title: 'Naza (2026)', EventType: 'Movie', Distributor: 'Liberty Hall Cinema', Status: 'active', CreatedBy: 'square-import' },
    { Kind: 'event', Title: 'Jazz Sunday', EventType: 'Live', Distributor: null, Status: 'active', CreatedBy: 'square-import' }
  ]);
  const showings = (await ctx.pgClient.query(`SELECT "StartsAt"::text AS "StartsAt", "Venue", "Descriptors", "Capacity" FROM "Showing" ORDER BY "ID"`)).rows;
  assert.deepEqual(showings, [
    { StartsAt: '2026-11-20 18:00:00', Venue: 'Main Auditorium', Descriptors: '', Capacity: 300 },
    { StartsAt: '2030-06-08 21:30:00', Venue: 'Little Theater', Descriptors: '21+', Capacity: null },
    { StartsAt: '2030-06-09 19:00:00', Venue: 'Spacement', Descriptors: '', Capacity: null }
  ]);
  assert.deepEqual((await ctx.pgClient.query(`SELECT "Name", "PriceCents" FROM "TicketType" ORDER BY "ID"`)).rows,
    [{ Name: 'Adult', PriceCents: 1250 }, { Name: 'Senior', PriceCents: 1100 }, { Name: 'Regular', PriceCents: 1000 }]);
  const links = (await ctx.pgClient.query(`SELECT "ExternalType", "ExternalID" FROM "ExternalCatalogLink" `)).rows.map((r) => `${r.ExternalType}:${r.ExternalID}`).sort();
  assert.deepEqual(links, ['ITEM:ITEM-LIVE', 'ITEM:ITEM-MOVIE', 'MODIFIER_LIST:LIST-LIVE', 'MODIFIER_LIST:LIST-MOVIE', 'MODIFIER:MOD-1', 'MODIFIER:MOD-2', 'MODIFIER:MOD-LIVE', 'ITEM_VARIATION:VAR-ADULT', 'ITEM_VARIATION:VAR-REGULAR', 'ITEM_VARIATION:VAR-SENIOR'].sort());
  const backfilled = (await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "QRCodeProduct" WHERE "ShowingID" IS NOT NULL`)).rows[0].n;
  assert.equal(backfilled, 2, 'the two MOD-1 tickets, not the other one');
  assert.deepEqual(writes, [], 'Square is only read');
});

test('import: running it again brings nothing in twice', async () => {
  await runImport(false);
  const again = (await runImport(false)).json;
  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.skipped.filter((s) => s.reason === 'already in IndieTix').map((s) => s.title).sort(), ['Jazz Sunday', 'Naza (2026)']);
  assert.equal(await count('Event'), 2);
});

test('import: an item whose showtime is already linked elsewhere is reported, and nothing of it is saved', async () => {
  await ctx.pgClient.query(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('showing', 999, 'square', 'MODIFIER', 'MOD-LIVE')`);
  const { json } = await runImport(false);
  assert.match(json.problems.find((p) => p.title === 'Jazz Sunday').problem, /already linked/);
  assert.equal((await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "Event" WHERE "Title" = 'Jazz Sunday'`)).rows[0].n, 0, 'rolled back');
  assert.equal((await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "Event" WHERE "Title" = 'Naza (2026)'`)).rows[0].n, 1, 'other items still came in');
});

test('import: the imported events show on the Showtimes page and can be managed', async () => {
  await runImport(false);
  const { json } = await ctx.request('GET', '/api/events', { token: ctx.clientToken });
  assert.deepEqual(json.events.map((e) => e.title).sort(), ['Jazz Sunday', 'Naza (2026)']);
});

test('import needs edit permission', async () => {
  const { token } = await ctx.insertUser({ username: 'importdoor', permissions: { view: false, edit: false, checkIn: true } });
  assert.equal((await ctx.request('POST', '/api/events/import-from-square', { token, body: { dryRun: true } })).status, 403);
});
