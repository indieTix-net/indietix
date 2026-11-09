import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { VENUE_TIMEZONE: 'America/Chicago' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

function catalogWithShowtime({ itemId = 'ITEM1', modListId = 'MODLIST1', modifierId = 'MOD1', title = 'Test Movie', showtimeStr = 'Sun 01-04-2026 2:30 PM (Main Theater)', description = 'Runtime: 100' } = {}) {
  return {
    objects: [
      {
        type: 'ITEM',
        id: itemId,
        item_data: {
          name: title,
          description,
          modifier_list_info: [{ modifier_list_id: modListId }]
        }
      }
    ],
    related_objects: [
      {
        type: 'MODIFIER_LIST',
        id: modListId,
        modifier_list_data: {
          modifiers: [{ id: modifierId, modifier_data: { name: showtimeStr } }]
        }
      }
    ]
  };
}

// ---- /api/square/showtimes-for-date ----

test('GET /api/square/showtimes-for-date: returns parsed showtimes matching the requested date', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => catalogWithShowtime() });
  const { status, json } = await ctx.request('GET', '/api/square/showtimes-for-date?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.showtimes.length, 1);
  assert.equal(json.showtimes[0].title, 'Test Movie');
  assert.equal(json.showtimes[0].location, 'Main Theater');
  assert.equal(json.showtimes[0].runtime, 100);
});

test('GET /api/square/showtimes-for-date: a showtime on a different date is excluded', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => catalogWithShowtime({ showtimeStr: 'Mon 01-05-2026 2:30 PM (Main Theater)' }) });
  const { json } = await ctx.request('GET', '/api/square/showtimes-for-date?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(json.showtimes.length, 0);
});

test('GET /api/square/showtimes-for-date: location filter excludes non-matching showtimes', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => catalogWithShowtime({ showtimeStr: 'Sun 01-04-2026 2:30 PM (Other Theater)' }) });
  const { json } = await ctx.request('GET', '/api/square/showtimes-for-date?date=2026-01-04&location=Main Theater', { token: ctx.clientToken });
  assert.equal(json.showtimes.length, 0);
});

test('GET /api/square/showtimes-for-date: missing date param is a 400', async () => {
  const { status } = await ctx.request('GET', '/api/square/showtimes-for-date', { token: ctx.clientToken });
  assert.equal(status, 400);
});

test('GET /api/square/showtimes-for-date: a Square search failure surfaces as a 500', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: false, status: 500, text: async () => 'square down' });
  const { status } = await ctx.request('GET', '/api/square/showtimes-for-date?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 500);
});

// ---- /api/dashboard/today ----

async function insertDashboardTicket({ qrCode, productName = 'Test Movie', productDate = '2026-01-04 14:30:00', checkedIn = false, status = 'valid', productMetadata = null }) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "CheckedIn", "Status", "ProductMetadata")
     VALUES ($1, '2099-01-01', $2, $3, 'Main', 'Movie', 'details', 'ITEM', $4, $5, $6)`,
    [qrCode, productDate, productName, checkedIn, status, productMetadata ? JSON.stringify(productMetadata) : null]
  );
}

test('GET /api/dashboard/today: with ?date=, aggregates ticket counts per showtime by modifier id', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => catalogWithShowtime({ modifierId: 'MOD-DASH-1' }) });
  await insertDashboardTicket({ qrCode: 'QR-DASH-1', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-DASH-1' }] } });
  await insertDashboardTicket({ qrCode: 'QR-DASH-2', checkedIn: true, productMetadata: { modifiers: [{ catalog_object_id: 'MOD-DASH-1' }] } });

  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.eventCount, 1);
  assert.equal(json.events[0].ticketsSold, 2);
  assert.equal(json.events[0].checkedIn, 1);
  assert.equal(json.events[0].matchedBy, 'modifier_id');
});

test('GET /api/dashboard/today: falls back to title matching when a ticket has no modifiers array', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => catalogWithShowtime({ title: 'Legacy Movie' }) });
  await insertDashboardTicket({ qrCode: 'QR-DASH-3', productName: 'Legacy Movie', productMetadata: null });

  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.events[0].ticketsSold, 1);
  assert.equal(json.events[0].matchedBy, 'title');
});

test('GET /api/dashboard/today: refunded/cancelled/transferred tickets are excluded from counts', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => catalogWithShowtime({ modifierId: 'MOD-DASH-EXCL' }) });
  await insertDashboardTicket({ qrCode: 'QR-DASH-4', status: 'valid', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-DASH-EXCL' }] } });
  await insertDashboardTicket({ qrCode: 'QR-DASH-5', status: 'refunded', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-DASH-EXCL' }] } });
  await insertDashboardTicket({ qrCode: 'QR-DASH-6', status: 'transferred', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-DASH-EXCL' }] } });

  const { json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(json.events[0].ticketsSold, 1);
});

test('GET /api/dashboard/today: no showtimes at all for the date returns an empty event list, not an error', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.eventCount, 0);
  assert.deepEqual(json.events, []);
});

test('GET /api/dashboard/today: an invalid ?date= (impossible day) falls back to venue-local today', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-02-30', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.notEqual(json.date, '2026-02-30');
});

test('GET /api/dashboard/today: a sub-user with an event-name data filter only sees matching showtimes', async () => {
  squareHandlers.searchCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [
        { type: 'ITEM', id: 'ITEM-A', item_data: { name: 'Wanted Movie', description: '', modifier_list_info: [{ modifier_list_id: 'ML-A' }] } },
        { type: 'ITEM', id: 'ITEM-B', item_data: { name: 'Other Movie', description: '', modifier_list_info: [{ modifier_list_id: 'ML-B' }] } }
      ],
      related_objects: [
        { type: 'MODIFIER_LIST', id: 'ML-A', modifier_list_data: { modifiers: [{ id: 'MOD-A', modifier_data: { name: 'Sun 01-04-2026 2:30 PM (Main)' } }] } },
        { type: 'MODIFIER_LIST', id: 'ML-B', modifier_list_data: { modifiers: [{ id: 'MOD-B', modifier_data: { name: 'Sun 01-04-2026 4:30 PM (Main)' } }] } }
      ]
    })
  });
  await insertDashboardTicket({ qrCode: 'QR-DASH-FILTER-A', productName: 'Wanted Movie', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-A' }] } });
  await insertDashboardTicket({ qrCode: 'QR-DASH-FILTER-B', productName: 'Other Movie', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-B' }] } });

  const { token } = await ctx.insertUser({
    username: 'dashboardfiltered',
    dataFilter: { datafilters: [{ event: 'Wanted Movie' }] }
  });
  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token });
  assert.equal(status, 200);
  assert.equal(json.filtered, true);
  assert.equal(json.eventCount, 1);
  assert.equal(json.events[0].title, 'Wanted Movie');
});

// Same two-item catalog as above; the filters below should each keep only "Wanted Movie".
for (const [label, datafilters] of [
  ['eventContains', [{ eventContains: 'wanted' }]],
  ["old 'cinema' event type", [{ eventType: 'cinema', eventContains: 'wanted' }]]
]) {
  test(`GET /api/dashboard/today: ${label} data filter is applied`, async () => {
    squareHandlers.searchCatalog = async () => ({
      ok: true, status: 200,
      json: async () => ({
        objects: [
          { type: 'ITEM', id: 'ITEM-A', item_data: { name: 'Wanted Movie', description: '', modifier_list_info: [{ modifier_list_id: 'ML-A' }] } },
          { type: 'ITEM', id: 'ITEM-B', item_data: { name: 'Other Movie', description: '', modifier_list_info: [{ modifier_list_id: 'ML-B' }] } }
        ],
        related_objects: [
          { type: 'MODIFIER_LIST', id: 'ML-A', modifier_list_data: { modifiers: [{ id: 'MOD-A', modifier_data: { name: 'Sun 01-04-2026 2:30 PM (Main)' } }] } },
          { type: 'MODIFIER_LIST', id: 'ML-B', modifier_list_data: { modifiers: [{ id: 'MOD-B', modifier_data: { name: 'Sun 01-04-2026 4:30 PM (Main)' } }] } }
        ]
      })
    });
    await insertDashboardTicket({ qrCode: `QR-DC-A-${label}`, productName: 'Wanted Movie', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-A' }] } });
    await insertDashboardTicket({ qrCode: `QR-DC-B-${label}`, productName: 'Other Movie', productMetadata: { modifiers: [{ catalog_object_id: 'MOD-B' }] } });

    const { token } = await ctx.insertUser({ username: `dash-${label.replace(/\W/g, '')}`, dataFilter: { datafilters } });
    const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token });
    assert.equal(status, 200);
    assert.equal(json.eventCount, 1);
    assert.equal(json.events[0].title, 'Wanted Movie');
  });
}

test('GET /api/dashboard/today: Square not configured builds the day from tickets (dashboardWithoutSquare.test.mjs), not a crash', async () => {
  const noTokenCtx = await startTestServer({ clientId: 'NOTOKENCLIENT', clientConfig: { SQUARE_ACCESS_TOKEN: '' } });
  try {
    const { status, json } = await noTokenCtx.request('GET', '/api/dashboard/today', { token: noTokenCtx.clientToken });
    assert.equal(status, 200);
    assert.equal(json.source, 'tickets');
  } finally {
    await stopTestServer(noTokenCtx);
  }
});
