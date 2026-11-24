import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';
import { installFakeCatalog } from './helpers/fakeSquareCatalog.mjs';
import { sameText, squareItemDescription } from '../src/utils/native-events.mjs';

// ---- EVENT DETAILS: edit name / description / poster, delete or end ----
// The Showtimes page's Event details panel (2026-11-23). Every change is
// made on the Square item and in IndieTix together.

let ctx;
let square;
let eventId;
let uploads;

before(async () => {
  ctx = await startTestServer({ clientConfig: { SQUARE_LOCATION_ID: 'LOC123', ROOM_CAPACITY: { 'Main Auditorium': 300 } } });
});
after(async () => { await stopTestServer(ctx); });

const FUTURE = ['Fri 06-07-2030 7:00 PM (Main Auditorium)', 'Sat 06-08-2030 9:30 PM (Main Auditorium)'];

beforeEach(async () => {
  resetSquareHandlers();
  square = installFakeCatalog(squareHandlers);
  uploads = 0;
  squareHandlers.uploadCatalogImage = async () => {
    const id = `UPLOADED_IMAGE_${++uploads}`;
    square.objects.set(id, { id, type: 'IMAGE', version: 1, image_data: { url: `https://example.test/${id}.jpg` } });
    const body = { image: { id } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  for (const table of ['ExternalCatalogLink', 'Showing', 'TicketType', 'Event', 'QRCodeProductToOrder', 'QRCodeProduct']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`);
  }
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', {
    token: ctx.clientToken, body: { movieData: { title: 'Details Test Movie', description: 'The old plot.', showtimes: FUTURE }, createCalendarEvents: false }
  });
  assert.equal(status, 200, JSON.stringify(json));
  eventId = json.eventId;
  // What Square sends back for a saved description.
  const item = square.objects.get('MOCK_ITEM_ID');
  item.item_data = { ...item.item_data, description_html: '<p>The old plot.</p>', description_plaintext: 'The old plot.' };
  square.calls.length = 0;
});

const call = (method, path, body, token = ctx.clientToken) => ctx.request(method, path, { token, body });
const eventRow = async () => (await ctx.pgClient.query(`SELECT "Title", "Description", "PosterUrl", "Status" FROM "Event" WHERE "ID" = $1`, [eventId])).rows[0];
const upserts = () => square.calls.filter((c) => c.op === 'upsert');
async function sellTicket(modifierId, status = 'valid') {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "ProductMetadata", "Status")
     VALUES ($1, '2030-09-01', '2030-06-07 19:00:00', 'Details Test Movie', 'LOC123', 'Movie', $4, 'MOCK_VAR_1', $2, $3)`,
    [`QR-${Math.random()}`, JSON.stringify({ modifiers: [{ catalog_object_id: modifierId, name: FUTURE[0] }] }), status, FUTURE[0]]);
}
async function pngDataUrl() {
  const png = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('Add Movie stores the description the Square item gets', async () => {
  const row = await eventRow();
  assert.ok(sameText(row.Description, squareItemDescription(square.objects.get('MOCK_ITEM_ID').item_data)));
});

test('edit: name and description change on the Square item (at its current version) and in IndieTix', async () => {
  const { status, json } = await call('PUT', `/api/events/${eventId}`, { title: '  New Name  ', description: 'A new plot.' });
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json.changed, ['name', 'description']);
  const [saved] = upserts();
  assert.equal(saved.object.version, 1, 'sent at the version it read');
  const item = square.objects.get('MOCK_ITEM_ID');
  assert.equal(item.item_data.name, 'New Name');
  assert.equal(item.item_data.description, 'A new plot.');
  assert.equal(item.item_data.description_html, undefined, 'Square remakes the HTML copy from the new text');
  const displayNames = Object.values(item.custom_attribute_values || {}).filter((v) => typeof v.string_value === 'string');
  assert.deepEqual(displayNames.map((v) => v.string_value), ['New Name'], 'the online display name follows the name');
  assert.ok(Object.values(item.custom_attribute_values).some((v) => v.boolean_value === true), 'UseQRCode kept');
  assert.equal(item.item_data.modifier_list_info[0].modifier_list_id, 'MOCK_MODIFIER_LIST_ID', 'showtimes kept');
  const row = await eventRow();
  assert.deepEqual([row.Title, row.Description], ['New Name', 'A new plot.']);
  assert.equal(json.event.title, 'New Name');
});

test('edit: saving unchanged details doesn\'t touch Square', async () => {
  const { json } = await call('GET', `/api/events/${eventId}/details`);
  const { status, json: saved } = await call('PUT', `/api/events/${eventId}`, { title: json.details.title, description: json.details.description });
  assert.equal(status, 200);
  assert.deepEqual(saved.changed, []);
  assert.equal(upserts().length, 0);
});

test('edit: a new poster is uploaded, made the item\'s image, and linked; replacing it closes the old link', async () => {
  const first = await call('PUT', `/api/events/${eventId}`, { posterDataUrl: await pngDataUrl() });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(first.json.changed, ['poster']);
  assert.deepEqual(square.objects.get('MOCK_ITEM_ID').item_data.image_ids, ['UPLOADED_IMAGE_1']);
  await call('PUT', `/api/events/${eventId}`, { posterDataUrl: await pngDataUrl() });
  assert.deepEqual(square.objects.get('MOCK_ITEM_ID').item_data.image_ids, ['UPLOADED_IMAGE_2']);
  const links = await ctx.pgClient.query(
    `SELECT "ExternalID", "DeletedReason" FROM "ExternalCatalogLink" WHERE "EntityType" = 'event' AND "EntityID" = $1 AND "ExternalType" = 'IMAGE' ORDER BY "ID"`, [eventId]);
  assert.deepEqual(links.rows.map((r) => [r.ExternalID, r.DeletedReason]), [['UPLOADED_IMAGE_1', 'replaced'], ['UPLOADED_IMAGE_2', null]]);
  const details = await call('GET', `/api/events/${eventId}/details`);
  assert.equal(details.json.details.imageUrl, null, 'the fake catalog returns no related objects');
});

test('edit: refused with nothing sent to Square for no name, nothing to change, or a poster that isn\'t an image', async () => {
  assert.equal((await call('PUT', `/api/events/${eventId}`, { title: '   ' })).status, 400);
  assert.equal((await call('PUT', `/api/events/${eventId}`, {})).status, 400);
  assert.equal((await call('PUT', `/api/events/${eventId}`, { posterDataUrl: 'https://example.com/poster.jpg' })).status, 400);
  assert.equal((await call('PUT', `/api/events/${eventId}`, { posterDataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' })).status, 400);
  assert.equal((await call('PUT', `/api/events/${eventId}`, { title: 'x'.repeat(256) })).status, 400);
  assert.equal(square.calls.length, 0);
});

test('edit: if Square refuses the change, IndieTix is unchanged and the uploaded poster is removed', async () => {
  square.failNext = 'upsert';
  const { status } = await call('PUT', `/api/events/${eventId}`, { title: 'Never Saved', posterDataUrl: await pngDataUrl() });
  assert.equal(status, 500);
  assert.equal((await eventRow()).Title, 'Details Test Movie');
  assert.equal(square.objects.has('UPLOADED_IMAGE_1'), false);
  const links = await ctx.pgClient.query(`SELECT 1 FROM "ExternalCatalogLink" WHERE "ExternalType" = 'IMAGE'`);
  assert.equal(links.rows.length, 0);
});

test('details: the form gets what customers see in Square, even after a change made there by hand', async () => {
  const item = square.objects.get('MOCK_ITEM_ID');
  item.item_data = { ...item.item_data, name: 'Renamed In Square', description_plaintext: 'Typed in Square.' };
  const { status, json } = await call('GET', `/api/events/${eventId}/details`);
  assert.equal(status, 200);
  assert.deepEqual([json.details.title, json.details.description], ['Renamed In Square', 'Typed in Square.']);
  // Saving the same name puts IndieTix back in step.
  const saved = await call('PUT', `/api/events/${eventId}`, { title: 'Renamed In Square', description: 'Typed in Square.' });
  assert.deepEqual(saved.json.changed, ['name', 'description']);
  assert.equal((await eventRow()).Title, 'Renamed In Square');
});

test('details and delete need edit permission', async () => {
  const { token } = await ctx.insertUser({ username: 'doordetails', permissions: { view: false, edit: false, checkIn: true } });
  assert.equal((await call('GET', `/api/events/${eventId}/details`, undefined, token)).status, 403);
  assert.equal((await call('PUT', `/api/events/${eventId}`, { title: 'Nope' }, token)).status, 403);
  assert.equal((await call('DELETE', `/api/events/${eventId}`, undefined, token)).status, 403);
});

test('delete: an event with no tickets is deleted from Square and IndieTix', async () => {
  assert.equal((await call('GET', `/api/events/${eventId}`)).json.event.ticketsEver, 0);
  const { status, json } = await call('DELETE', `/api/events/${eventId}`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.action, 'deleted');
  assert.equal(square.objects.has('MOCK_ITEM_ID'), false);
  assert.equal(square.objects.has('MOCK_MODIFIER_LIST_ID'), false);
  for (const table of ['Event', 'Showing', 'TicketType', 'ExternalCatalogLink']) {
    assert.equal((await ctx.pgClient.query(`SELECT 1 FROM "${table}"`)).rows.length, 0, `${table} emptied`);
  }
  assert.equal((await call('GET', `/api/events/${eventId}`)).status, 404);
});

test('delete: an event with tickets (even only refunded ones) is ended: upcoming showtimes off Square, item archived, nothing refunded', async () => {
  await sellTicket('MOCK_MOD_0');
  await sellTicket('MOCK_MOD_0', 'refunded');
  assert.equal((await call('GET', `/api/events/${eventId}`)).json.event.ticketsEver, 2);
  const { status, json } = await call('DELETE', `/api/events/${eventId}`);
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual([json.action, json.cancelledShowtimes, json.ticketsToRefund, json.archived], ['ended', 2, 1, true]);
  assert.equal(square.objects.has('MOCK_MOD_0'), false);
  assert.equal(square.objects.get('MOCK_ITEM_ID').item_data.is_archived, true);
  assert.deepEqual(json.event.showings.map((s) => s.status), ['cancelled', 'cancelled']);
  assert.equal(json.event.status, 'archived');
  const tickets = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" ORDER BY "Status"`);
  assert.deepEqual(tickets.rows.map((r) => r.Status), ['refunded', 'valid']);
});

test('delete: if Square won\'t delete the item, nothing is deleted', async () => {
  square.failNext = 'delete';
  assert.equal((await call('DELETE', `/api/events/${eventId}`)).status, 500);
  assert.equal((await eventRow()).Status, 'active');
  assert.equal((await call('GET', `/api/events/${eventId}`)).json.event.showings.length, 2);
});
