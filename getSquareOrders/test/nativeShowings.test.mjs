import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
// Must be imported BEFORE '../src/index.mjs' (see processWebhook.test.mjs).
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  resetS3Handlers, resetSesHandlers, resetSmsHandlers,
  buildSqsEvent, buildSqsRecord, computeSquareSignature
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

// ---- NATIVE EVENTS step 3: tickets get their showing; full showings stop selling ----
// Replays a real recorded Liberty Hall sale (2 Senior tickets, one line,
// one showtime modifier) against IndieTix's own copy of that event.

const fx = JSON.parse(readFileSync(new URL('./fixtures/liberty-hall/register-card-multi-qty.json', import.meta.url)));
const LINE = fx.order.order.line_items[0];
const MODIFIER_ID = LINE.modifiers[0].catalog_object_id;
const VARIATION_ID = LINE.catalog_object_id;
const ITEM_ID = fx.catalog.objects.find((o) => o.id === VARIATION_ID).item_variation_data.item_id;
const RECORDED = fx.expected.tickets[0];

const CLIENT_ID = 'LHFIXTUREMERCHANT';
const SIG_KEY = 'native-showings-sig-key';
const WEBHOOK_URL = 'https://example.com/prod/webhook';
let ctx;
let squareCalls;

before(async () => {
  ctx = await startTestEnv({ clientId: CLIENT_ID, clientConfig: {
    ENV_TYPE: 'prod', SQUARE_SIGNATURE_KEY: SIG_KEY, SQUARE_WEBHOOK_URL: WEBHOOK_URL,
    WEB_HEADER_COMPANY: 'Liberty Hall', OWNER_BCC_EMAIL: 'owner@example.com', WALKUP_PHONE: '+15555550100'
  } });
});
after(async () => { await stopTestEnv(ctx); });

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' });

beforeEach(async () => {
  resetSquareHandlers(); resetSesHandlers(); resetSmsHandlers();
  const doc = await PDFDocument.create(); doc.addPage([1800, 600]);
  resetS3Handlers(Buffer.from(await doc.save()));
  for (const t of ['QRCodeProductToOrder', 'QRCodeProduct', 'Order', 'Customer', 'NoTicketOrder', 'ExternalCatalogLink', 'Showing', 'TicketType', 'Event']) {
    await ctx.pgClient.query(`DELETE FROM "${t}"`).catch(() => {});
  }
  await setEnforce(false);
  squareCalls = [];
  squareHandlers.getPayment = async () => ok(fx.payment);
  squareHandlers.getOrder = async () => ok(fx.order);
  squareHandlers.getCustomer = async () => ok(fx.customer);
  squareHandlers.batchRetrieveCatalog = async () => ok(fx.catalog);
  const item = { type: 'ITEM', id: ITEM_ID, version: 5, custom_attribute_values: { qr: { boolean_value: true } }, item_data: { name: LINE.name, is_archived: false } };
  squareHandlers.getCatalogObject = async (id) => {
    if (id === ITEM_ID) { squareCalls.push(['get', id]); return ok({ object: item }); }
    const selections = fx.selectionDefinitions[id];
    return selections ? ok({ object: { id, custom_attribute_definition_data: { selection_config: { allowed_selections: selections } } } }) : notFound();
  };
  squareHandlers.deleteCatalogObject = async (id) => { squareCalls.push(['delete', id]); return ok({ deleted_object_ids: [id] }); };
  squareHandlers.upsertCatalogObject = async (body) => { squareCalls.push(['upsert', body.object.id, body.object.item_data?.is_archived]); return ok({ catalog_object: body.object }); };
});

async function setEnforce(on) {
  await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb`, [JSON.stringify({ ENFORCE_CAPACITY: on ? 'true' : 'false' })]);
}

// IndieTix's copy of the recorded sale's event, linked like Add Movie links it.
async function seedEvent({ startsAt = RECORDED.ProductDate, venue = RECORDED.ProductVenue, capacity = null, heldSeats = 0, linkModifier = true, otherUpcoming = false } = {}) {
  const q = (sql, params) => ctx.pgClient.query(sql, params);
  const eventId = (await q(`INSERT INTO "Event" ("Kind", "Title", "EventType", "Status") VALUES ('movie', $1, 'Movie', 'active') RETURNING "ID"`, [LINE.name])).rows[0].ID;
  const ticketTypeId = (await q(`INSERT INTO "TicketType" ("EventID", "Name", "PriceCents") VALUES ($1, 'Senior', 1100) RETURNING "ID"`, [eventId])).rows[0].ID;
  const showingId = (await q(`INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Label", "Capacity", "HeldSeats") VALUES ($1, $2, $3, $4, $5, $6) RETURNING "ID"`,
    [eventId, startsAt, venue, LINE.modifiers[0].name, capacity, heldSeats])).rows[0].ID;
  const link = (type, id, extType, extId) => q(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ($1, $2, 'square', $3, $4)`, [type, id, extType, extId]);
  await link('event', eventId, 'ITEM', ITEM_ID);
  await link('ticket_type', ticketTypeId, 'ITEM_VARIATION', VARIATION_ID);
  if (linkModifier) await link('showing', showingId, 'MODIFIER', MODIFIER_ID);
  if (otherUpcoming) {
    const other = (await q(`INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Label") VALUES ($1, '2030-01-01 19:00:00', 'Main Auditorium', 'Tue 01-01-2030 7:00 PM (Main Auditorium)') RETURNING "ID"`, [eventId])).rows[0].ID;
    await link('showing', other, 'MODIFIER', 'OTHER-MODIFIER');
  }
  return { eventId, showingId };
}

async function sell() {
  const body = JSON.stringify(fx.webhook);
  const record = buildSqsRecord(fx.webhook, { 'x-square-hmacsha256-signature': computeSquareSignature(WEBHOOK_URL, body, SIG_KEY) });
  const result = await handler(buildSqsEvent([record]));
  assert.equal(JSON.parse(result.body).results.success, 1);
  return (await ctx.pgClient.query(`SELECT "ShowingID", "ProductDate"::text AS "ProductDate", "ProductVenue", "ProductName", "ProductPrice", "ProductSeatCode" FROM "QRCodeProduct" ORDER BY "ID"`)).rows;
}
const showing = async (id) => (await ctx.pgClient.query(`SELECT "Status", "SoldOutAt" IS NOT NULL AS "soldOutAt" FROM "Showing" WHERE "ID" = $1`, [id])).rows[0];
function captureErrors(t) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => lines.push(args.map(String).join(' ')));
  return lines;
}

test('a ticket for a showing IndieTix knows records its ShowingID; everything else matches what production recorded', async () => {
  const { showingId } = await seedEvent();
  const tickets = await sell();
  assert.equal(tickets.length, 2);
  for (const t of tickets) {
    assert.equal(t.ShowingID, showingId);
    assert.equal(t.ProductDate, RECORDED.ProductDate);
    assert.equal(t.ProductVenue, RECORDED.ProductVenue);
    assert.equal(t.ProductName, RECORDED.ProductName);
    assert.equal(Number(t.ProductPrice), RECORDED.ProductPrice);
    assert.equal(t.ProductSeatCode, RECORDED.ProductSeatCode);
  }
  assert.deepEqual(squareCalls, [], 'capacity off: Square untouched');
});

test('the showing\'s own time and room are used for the ticket', async () => {
  await seedEvent({ startsAt: '2026-11-20 15:00:00', venue: 'Little Theater' });
  const [t] = await sell();
  assert.deepEqual([t.ProductDate, t.ProductVenue], ['2026-11-20 15:00:00', 'Little Theater']);
});

test('a sale for one of our items at a showtime IndieTix doesn\'t know: ticket issued from the text, flagged UNMATCHED_SHOWTIME', async (t) => {
  const errors = captureErrors(t);
  await seedEvent({ linkModifier: false });
  const tickets = await sell();
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].ShowingID, null);
  assert.equal(tickets[0].ProductDate, RECORDED.ProductDate);
  assert.equal(errors.filter((e) => e.includes('UNMATCHED_SHOWTIME')).length, 1);
});

test('an item IndieTix has no copy of (Liberty Hall today) is not flagged', async (t) => {
  const errors = captureErrors(t);
  const tickets = await sell();
  assert.equal(tickets[0].ShowingID, null);
  assert.deepEqual(errors.filter((e) => e.includes('UNMATCHED_SHOWTIME')), []);
});

// ---- capacity (ENFORCE_CAPACITY) ----

test('capacity: the sale that fills a showing removes its showtime from Square and marks it sold out', async () => {
  await setEnforce(true);
  const { showingId } = await seedEvent({ capacity: 2, otherUpcoming: true });
  await sell();
  assert.deepEqual(squareCalls, [['delete', MODIFIER_ID]], 'only the full showtime; the item stays (another showtime is upcoming)');
  assert.deepEqual(await showing(showingId), { Status: 'sold_out', soldOutAt: true });
  const link = await ctx.pgClient.query(`SELECT "DeletedReason" FROM "ExternalCatalogLink" WHERE "ExternalID" = $1`, [MODIFIER_ID]);
  assert.equal(link.rows[0].DeletedReason, 'sold_out');
});

test('capacity: held seats count against it (capacity 3, 1 held, 2 sold = full)', async () => {
  await setEnforce(true);
  const { showingId } = await seedEvent({ capacity: 3, heldSeats: 1, otherUpcoming: true });
  await sell();
  assert.equal((await showing(showingId)).Status, 'sold_out');
});

test('capacity: not full yet = nothing changes in Square', async () => {
  await setEnforce(true);
  const { showingId } = await seedEvent({ capacity: 10 });
  await sell();
  assert.deepEqual(squareCalls, []);
  assert.equal((await showing(showingId)).Status, 'on_sale');
});

test('capacity: no limit (NULL) never sells out', async () => {
  await setEnforce(true);
  await seedEvent({ capacity: null });
  await sell();
  assert.deepEqual(squareCalls, []);
});

test('capacity: with ENFORCE_CAPACITY off, a full showing stays on sale', async () => {
  const { showingId } = await seedEvent({ capacity: 1 });
  await sell();
  assert.deepEqual(squareCalls, []);
  assert.equal((await showing(showingId)).Status, 'on_sale');
});

test('capacity: filling the last upcoming showing also archives the item, keeping the whole item', async () => {
  await setEnforce(true);
  const { eventId } = await seedEvent({ startsAt: '2030-01-02 19:00:00', capacity: 2 });
  await sell();
  assert.deepEqual(squareCalls, [['delete', MODIFIER_ID], ['get', ITEM_ID], ['upsert', ITEM_ID, true]]);
  assert.equal((await ctx.pgClient.query(`SELECT "Status" FROM "Event" WHERE "ID" = $1`, [eventId])).rows[0].Status, 'archived');
});

test('capacity: if Square fails, the order still succeeds with its tickets, the showing stays on sale, and it is flagged', async (t) => {
  const errors = captureErrors(t);
  await setEnforce(true);
  squareHandlers.deleteCatalogObject = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'Square is down' });
  const { showingId } = await seedEvent({ capacity: 2 });
  const tickets = await sell();
  assert.equal(tickets.length, 2);
  assert.equal((await showing(showingId)).Status, 'on_sale');
  assert.equal(errors.filter((e) => e.includes('CAPACITY_ENFORCEMENT_FAILED')).length, 1);
  assert.equal((await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "Order"`)).rows[0].n, 1);
});

test('capacity: refunded tickets don\'t count toward it', async () => {
  await setEnforce(true);
  const { showingId } = await seedEvent({ capacity: 3 });
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status", "ShowingID")
     VALUES ('OLD-REFUNDED', '2030-01-01', $1, $2, 'L', 'Movie', 'x', 'x', 'refunded', $3)`, [RECORDED.ProductDate, LINE.name, showingId]);
  await sell();
  assert.equal((await showing(showingId)).Status, 'on_sale', '2 sold + 1 refunded < 3');
});

// Last: drops the tables.
test('a venue database without the native event tables processes sales exactly as before', async (t) => {
  const errors = captureErrors(t);
  await setEnforce(true);
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event']) await ctx.pgClient.query(`DROP TABLE "${table}"`);
  const tickets = await sell();
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].ShowingID, null);
  assert.deepEqual(errors.filter((e) => /Showing lookup failed|CAPACITY/.test(e)), []);
});
