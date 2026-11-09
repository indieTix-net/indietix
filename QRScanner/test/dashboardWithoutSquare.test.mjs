import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

// A venue with no Square token (the demo venue, or a self-hoster who hasn't
// connected Square): the today dashboard is built from its own tickets.
let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { VENUE_TIMEZONE: 'America/Chicago', SQUARE_ACCESS_TOKEN: '' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

let n = 0;
async function ticket({ name = 'Night Movie', date = '2026-01-04 19:00:00', details = 'Sun 01-04-2026 7:00 PM (Studio Theater, 21+)', venue = 'Studio Theater', type = 'Movie', checkedIn = false, status = 'valid' } = {}) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "ProductVenue", "CheckedIn", "Status")
     VALUES ($1, '2099-01-01', $2, $3, 'LOC', $4, $5, $6, $7, $8, $9)`,
    [`QR-NOSQ-${++n}`, date, name, type, details, `ITEM-${name}`, venue, checkedIn, status]
  );
}

test('without Square: the day\'s shows come from tickets, with sold and checked-in counts', async () => {
  squareHandlers.searchCatalog = async () => { throw new Error('Square must not be called without a token'); };
  await ticket();
  await ticket({ checkedIn: true });
  await ticket({ status: 'refunded' });
  await ticket({ name: 'Matinee', date: '2026-01-04 13:00:00', details: 'Sun 01-04-2026 1:00 PM (Main Auditorium)', venue: 'Main Auditorium' });
  await ticket({ name: 'Tomorrow', date: '2026-01-05 19:00:00', details: 'Mon 01-05-2026 7:00 PM (Main Auditorium)' });

  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.source, 'tickets');
  assert.deepEqual(json.events.map(e => [e.title, e.displayTime, e.location, e.ticketsSold, e.checkedIn]), [
    ['Matinee', '1:00 PM', 'Main Auditorium', 1, 0],
    ['Night Movie', '7:00 PM', 'Studio Theater', 2, 1]
  ]);
  assert.deepEqual(json.events[1].descriptors, ['21+']);
  assert.equal(json.events[1].matchedBy, 'tickets');
});

test('without Square: a day with no tickets is an empty list, not an error', async () => {
  const { status, json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.eventCount, 0);
});

test('without Square: a staff login\'s data filter still applies', async () => {
  await ticket();
  await ticket({ name: 'Live Band', type: 'Live', date: '2026-01-04 21:00:00', details: 'Sun 01-04-2026 9:00 PM (The Lounge)', venue: 'The Lounge' });
  const { token } = await ctx.insertUser({
    username: 'lounge-door', permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false },
    dataFilter: { datafilters: [{ eventType: 'Live' }] }
  });
  const { json } = await ctx.request('GET', '/api/dashboard/today?date=2026-01-04', { token });
  assert.equal(json.filtered, true);
  assert.deepEqual(json.events.map(e => e.title), ['Live Band']);
});
