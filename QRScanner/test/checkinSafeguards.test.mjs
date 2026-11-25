import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

// ---- CHECK-IN SAFEGUARDS ----
// 1. Two scans of one ticket at once: exactly one checks in.
// 2. A ticket for another day, or a show well before/after now, asks the
//    door first; "admit anyway" checks it in and is logged as an override.
// 3. Every check-in, check-out and refusal is logged with who did it, and
//    a repeat scan says who checked the ticket in and when.

let ctx;
before(async () => { ctx = await startTestServer({ clientConfig: { VENUE_TIMEZONE: 'America/Chicago' } }); });
after(async () => { await stopTestServer(ctx); });
beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "CheckInLog"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

// hoursFromNow: the show starts that many hours from now, venue time.
async function ticket(qrCode, { hoursFromNow = 0, status = 'valid', checkedIn = false } = {}) {
  const date = `(NOW() AT TIME ZONE 'America/Chicago') + make_interval(mins => ${Math.round(hoursFromNow * 60)})`;
  const r = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "CheckedIn", "Status")
     VALUES ($1, '2099-01-01', ${date}, 'The Long Night', 'Main Auditorium', 'Movie', 'details', 'ITEM', $2, $3) RETURNING "ID"`,
    [qrCode, checkedIn, status]);
  return r.rows[0].ID;
}
const checkIn = (qrCode, { token = ctx.clientToken, ...body } = {}) =>
  ctx.request('POST', '/api/checkin', { token, body: { qrCode, ...body } });
const log = async () => (await ctx.pgClient.query(`SELECT * FROM "CheckInLog" ORDER BY "ID"`)).rows;
const isCheckedIn = async (id) => (await ctx.pgClient.query(`SELECT "CheckedIn" FROM "QRCodeProduct" WHERE "ID" = $1`, [id])).rows[0].CheckedIn;

test('two phones scanning the same ticket at once: exactly one checks it in', async () => {
  await ticket('QR-RACE');
  const results = await Promise.all(Array.from({ length: 6 }, () => checkIn('QR-RACE')));
  const statuses = results.map(r => r.json.returnStatus);
  assert.equal(statuses.filter(s => s === 'successful_checkin').length, 1, statuses.join(', '));
  assert.equal(statuses.filter(s => s === 'failed_already_checked_in').length, 5, statuses.join(', '));
  const rows = await log();
  assert.equal(rows.filter(r => r.Action === 'check_in').length, 1);
  assert.equal(rows.filter(r => r.Action === 'refused').length, 5);
});

test('near its showtime a ticket checks in with no question, and says what it is', async () => {
  for (const [qr, h] of [['QR-SOON', 2], ['QR-STARTED', -3]]) {
    const id = await ticket(qr, { hoursFromNow: h });
    const { json } = await checkIn(qr);
    assert.equal(json.returnStatus, 'successful_checkin', qr);
    assert.equal(json.overridden, false, qr);
    assert.equal(json.productName, 'The Long Night');
    assert.equal(await isCheckedIn(id), true, qr);
  }
  const { json } = await checkIn('QR-ANOTHER', {}); // unknown code still reads as unknown
  assert.equal(json.returnStatus, 'failed_no_QRCode');
});

test('a ticket for another day asks first and stays unchecked; admitting anyway checks it in and logs the override', async () => {
  const id = await ticket('QR-TOMORROW', { hoursFromNow: 30 });
  const ask = await checkIn('QR-TOMORROW');
  assert.equal(ask.json.returnStatus, 'needs_confirm_showtime');
  assert.equal(ask.json.reason, 'other_day');
  assert.equal(ask.json.productName, 'The Long Night');
  assert.match(ask.json.showtime, /\d:\d\d [AP]M/);
  assert.equal(await isCheckedIn(id), false);
  assert.equal((await log()).length, 0, 'a question isn\'t a check-in or a refusal');

  const admit = await checkIn('QR-TOMORROW', { override: true, source: 'manual' });
  assert.equal(admit.json.returnStatus, 'successful_checkin');
  assert.equal(admit.json.overridden, true);
  assert.equal(await isCheckedIn(id), true);
  const [row] = await log();
  assert.deepEqual([row.Action, row.Override, row.OverrideReason, row.Source, row.UserType], ['check_in', true, 'other_day', 'manual', 'client']);
});

test('an earlier or later show asks too (same day or not), and override doesn\'t skip the other checks', async () => {
  await ticket('QR-EARLIER', { hoursFromNow: -6 });
  await ticket('QR-LATER', { hoursFromNow: 6 });
  const earlier = await checkIn('QR-EARLIER');
  const later = await checkIn('QR-LATER');
  assert.equal(earlier.json.returnStatus, 'needs_confirm_showtime');
  assert.equal(later.json.returnStatus, 'needs_confirm_showtime');
  assert.ok(['earlier_show', 'other_day'].includes(earlier.json.reason), earlier.json.reason);
  assert.ok(['later_show', 'other_day'].includes(later.json.reason), later.json.reason);

  await ticket('QR-REFUNDED-TOMORROW', { hoursFromNow: 30, status: 'refunded' });
  const refunded = await checkIn('QR-REFUNDED-TOMORROW', { override: true });
  assert.equal(refunded.json.returnStatus, 'failed_ticket_not_valid');
});

test('a repeat scan says who checked the ticket in and when; staff logins are named', async () => {
  await ticket('QR-STAFF');
  const { token, id: userId } = await ctx.insertUser({ username: 'doorsam', permissions: { view: false, edit: false, checkIn: true } });
  assert.equal((await checkIn('QR-STAFF', { token })).json.returnStatus, 'successful_checkin');
  const again = await checkIn('QR-STAFF');
  assert.equal(again.json.returnStatus, 'failed_already_checked_in');
  assert.equal(again.json.checkedInBy, 'doorsam');
  assert.ok(!Number.isNaN(Date.parse(again.json.checkedInAt)));
  const rows = await log();
  assert.deepEqual(rows.map(r => [r.Action, r.UserType, r.UserID, r.Result]), [
    ['check_in', 'user', userId, 'successful_checkin'],
    ['refused', 'client', null, 'failed_already_checked_in']
  ]);

  await ticket('QR-MAIN');
  await checkIn('QR-MAIN');
  assert.equal((await checkIn('QR-MAIN', { token })).json.checkedInBy, 'Main login');
});

test('check-out is logged once, and a second check-out of the same ticket fails', async () => {
  await ticket('QR-OUT', { checkedIn: true });
  const first = await ctx.request('POST', '/api/checkout', { token: ctx.clientToken, body: { qrCode: 'QR-OUT', source: 'manual' } });
  const second = await ctx.request('POST', '/api/checkout', { token: ctx.clientToken, body: { qrCode: 'QR-OUT' } });
  assert.equal(first.json.returnStatus, 'successful_checkout');
  assert.equal(second.json.returnStatus, 'failed_already_checked_out');
  assert.deepEqual((await log()).map(r => [r.Action, r.Source]), [['check_out', 'manual']]);
});

test('check-ins through the Data API are logged against the key', async () => {
  await ticket('QR-API');
  const created = await ctx.request('POST', '/api/api-keys', { token: ctx.clientToken, body: { name: 'Gate tablet', scopes: ['checkin:write'] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { status } = await ctx.request('POST', '/v1/checkins', { token: created.json.key, body: { qr_code: 'QR-API' } });
  assert.equal(status, 201);
  const [row] = await log();
  assert.deepEqual([row.Action, row.Source, row.UserType], ['check_in', 'api', 'api']);
  assert.ok(row.ApiKeyID);
  assert.equal((await checkIn('QR-API')).json.checkedInBy, 'API key: Gate tablet');
});

// Last: drops the table.
test('a venue database without the CheckInLog table still checks tickets in', async () => {
  await ticket('QR-NOLOG');
  await ctx.pgClient.query(`DROP TABLE "CheckInLog"`);
  assert.equal((await checkIn('QR-NOLOG')).json.returnStatus, 'successful_checkin');
  const again = await checkIn('QR-NOLOG');
  assert.equal(again.json.returnStatus, 'failed_already_checked_in');
  assert.equal(again.json.checkedInBy, undefined);
});
