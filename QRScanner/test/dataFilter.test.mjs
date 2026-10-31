import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { SQUARE_ACCESS_TOKEN: 'test-square-token' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Users"`);
});

async function insertTicket({ qrCode, productName = 'Movie', productType = 'Movie' }) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', $2, 'Main', $3, 'details', 'ITEM')`,
    [qrCode, productName, productType]
  );
}

// ---- event type filters ----

for (const eventType of ['Movie', 'cinema']) {
  test(`data filter eventType '${eventType}' matches Movie tickets only`, async () => {
    await insertTicket({ qrCode: 'QR-MOVIE', productType: 'Movie' });
    await insertTicket({ qrCode: 'QR-LIVE', productType: 'Live' });
    const { token } = await ctx.insertUser({ username: `type-${eventType}`, dataFilter: { datafilters: [{ eventType }] } });
    const { status, json } = await ctx.request('GET', '/api/products', { token });
    assert.equal(status, 200);
    assert.deepEqual(json.map(t => t.qrCode), ['QR-MOVIE']);
  });
}

test("data filter eventType 'live' matches Live tickets only", async () => {
  await insertTicket({ qrCode: 'QR-MOVIE', productType: 'Movie' });
  await insertTicket({ qrCode: 'QR-LIVE', productType: 'Live' });
  const { token } = await ctx.insertUser({ username: 'type-live', dataFilter: { datafilters: [{ eventType: 'live' }] } });
  const { json } = await ctx.request('GET', '/api/products', { token });
  assert.deepEqual(json.map(t => t.qrCode), ['QR-LIVE']);
});

// ---- event name: exact vs contains ----

async function visibleFor(username, datafilters) {
  const { token } = await ctx.insertUser({ username, dataFilter: { datafilters } });
  const { json } = await ctx.request('GET', '/api/products', { token });
  return json.map(t => t.qrCode).sort();
}

test('data filter event is an exact (case-insensitive) name match', async () => {
  await insertTicket({ qrCode: 'QR-SHORT', productName: 'Rocky Horror' });
  await insertTicket({ qrCode: 'QR-LONG', productName: 'The Rocky Horror Picture Show' });
  assert.deepEqual(await visibleFor('exact', [{ event: 'rocky horror' }]), ['QR-SHORT']);
});

test('data filter eventContains matches any part of the name', async () => {
  await insertTicket({ qrCode: 'QR-SHORT', productName: 'Rocky Horror' });
  await insertTicket({ qrCode: 'QR-LONG', productName: 'The Rocky Horror Picture Show' });
  await insertTicket({ qrCode: 'QR-OTHER', productName: 'Jaws' });
  assert.deepEqual(await visibleFor('contains', [{ eventContains: 'rocky' }]), ['QR-LONG', 'QR-SHORT']);
});

test('data filter eventContains treats % and _ literally', async () => {
  await insertTicket({ qrCode: 'QR-PCT', productName: '100% Live' });
  await insertTicket({ qrCode: 'QR-OTHER', productName: '1000 Live' });
  assert.deepEqual(await visibleFor('literal', [{ eventContains: '0%' }]), ['QR-PCT']);
  assert.deepEqual(await visibleFor('underscore', [{ eventContains: '1_0' }]), []);
});

test('data filter eventContains ANDs with the other fields in the same filter', async () => {
  await insertTicket({ qrCode: 'QR-MOVIE', productName: 'Jazz Night', productType: 'Movie' });
  await insertTicket({ qrCode: 'QR-LIVE', productName: 'Jazz Night Live', productType: 'Live' });
  assert.deepEqual(await visibleFor('and', [{ eventContains: 'jazz', eventType: 'Live' }]), ['QR-LIVE']);
});

test('data filter eventContains applies to single-ticket lookups too', async () => {
  await insertTicket({ qrCode: 'QR-IN', productName: 'Jazz Night' });
  await insertTicket({ qrCode: 'QR-OUT', productName: 'Jaws' });
  const { token } = await ctx.insertUser({ username: 'single', dataFilter: { datafilters: [{ eventContains: 'jazz' }] } });
  const inside = await ctx.request('GET', '/api/product_by_qrcode?search=QR-IN', { token });
  assert.equal(inside.json.length, 1);
  const outside = await ctx.request('GET', '/api/product_by_qrcode?search=QR-OUT', { token });
  assert.deepEqual(outside.json, []);
});

// ---- /api/data-filter/events ----

test('GET /api/data-filter/events: catalog items plus sold ticket names, deduped and sorted', async () => {
  await insertTicket({ qrCode: 'QR-1', productName: 'Past Show' });
  await insertTicket({ qrCode: 'QR-2', productName: 'Both Places' });
  squareHandlers.searchCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [
        { type: 'ITEM', id: 'I1', item_data: { name: 'Upcoming Show' }, custom_attribute_values: { a: { name: 'UseQRCode', boolean_value: true } } },
        { type: 'ITEM', id: 'I2', item_data: { name: 'Both Places' }, custom_attribute_values: { a: { name: 'UseQRCode', boolean_value: true } } },
        { type: 'ITEM', id: 'I3', item_data: { name: 'Popcorn' } }
      ]
    })
  });
  const { status, json } = await ctx.request('GET', '/api/data-filter/events', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json.events, ['Both Places', 'Past Show', 'Upcoming Show']);
});

test('GET /api/data-filter/events: Square failing still returns sold ticket names', async () => {
  await insertTicket({ qrCode: 'QR-1', productName: 'Past Show' });
  squareHandlers.searchCatalog = async () => ({ ok: false, status: 503, text: async () => 'down', json: async () => ({}) });
  const { status, json } = await ctx.request('GET', '/api/data-filter/events', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json.events, ['Past Show']);
});

test('GET /api/data-filter/events: client login only', async () => {
  const { token } = await ctx.insertUser({
    username: 'admin-sub',
    permissions: { view: true, edit: true, checkIn: true, marketing: true, admin: true }
  });
  const { status } = await ctx.request('GET', '/api/data-filter/events', { token });
  assert.equal(status, 403);
});
