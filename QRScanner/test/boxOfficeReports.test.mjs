import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';
import { buildZip } from '../src/utils/zip.mjs';

// The Box Office Reports page: the nightly RTS/FRG files for a date range,
// built on the spot and returned as a .zip.
let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', EBOR_THEATRE_NO: '902063' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

async function insertTicket({ productDate, price = 10, status = 'valid', name = 'Test Movie' }) {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct"
      ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation",
       "ProductType", "ProductDetails", "ProductPrice", "ProductID", "ProductVenue",
       "ProductSeatCode", "Status")
     VALUES ($1, '2099-01-01', $2, $3, 'Main', 'Movie', 'details', $4, 'ITEM', 'Main Theatre', 'Adult', $5)`,
    [`QR-${Math.random().toString(36).slice(2)}`, productDate, name, price, status]
  );
}

// Reads back a zip's files (name -> text) by walking its central directory.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + size));
    assert.equal(zlib.crc32(data), crc, `${name} checksum`);
    files[name] = data.toString('utf8');
    at += 46 + nameLength;
  }
  return files;
}

const get = (query, token = ctx.clientToken) => ctx.request('GET', `/api/box-office-reports?${query}`, { token });

test('buildZip: files round-trip, names and contents intact', () => {
  const files = readZip(buildZip([{ name: 'a.csv', content: 'x,y\r\n' }, { name: 'b.xml', content: '' }]));
  assert.deepEqual(files, { 'a.csv': 'x,y\r\n', 'b.xml': '' });
});

test('GET /api/box-office-reports: one RTS + FRG per day, matching the report functions exactly', async () => {
  await insertTicket({ productDate: '2026-04-26 19:00:00', price: 10.93 });
  await insertTicket({ productDate: '2026-04-26 19:00:00', price: 10.93 });
  await insertTicket({ productDate: '2026-04-26 21:00:00', price: 12, name: 'Late, Show & Co' });
  await insertTicket({ productDate: '2026-04-26 19:00:00', price: 10.93, status: 'refunded' });
  await insertTicket({ productDate: '2026-04-28 19:00:00', price: 8 });

  const { status, json } = await get('from=2026-04-26&to=2026-04-28');
  assert.equal(status, 200);
  assert.equal(json.fileName, 'box-office-2026-04-26-to-2026-04-28.zip');
  assert.deepEqual(json.days.map(d => [d.date, d.rtsFile, d.frgFile]), [
    ['2026-04-26', 'RTS_69938_202604260000.csv', 'FRG_902063_202604260000.xml'],
    ['2026-04-27', 'RTS_69938_202604270000.csv', 'FRG_902063_202604270000.xml'],
    ['2026-04-28', 'RTS_69938_202604280000.csv', 'FRG_902063_202604280000.xml']
  ]);
  assert.equal(json.days[1].rows, 0);

  const files = readZip(Buffer.from(json.zip, 'base64'));
  assert.equal(Object.keys(files).length, 6);
  assert.equal(files['RTS_69938_202604270000.csv'], 'No data found\n');
  assert.equal(files['FRG_902063_202604270000.xml'], '<Nightly_box_office>\n<20260427>\n</20260427>\n</Nightly_box_office>\n');

  // Same rows the nightly job would turn into its files.
  const rts = await ctx.pgClient.query('SELECT * FROM get_bdor_grouped_for_date($1, $2, $3)', ['69938', 'Test Theatre', '2026-04-26']);
  assert.ok(rts.rows.length >= 2);
  const csv = files['RTS_69938_202604260000.csv'];
  assert.equal(csv.split('\r\n').length - 1, rts.rows.length);
  assert.match(csv, /^69938,Test Theatre,/);
  assert.match(csv, /"Late, Show & Co"/);
  const ebor = await ctx.pgClient.query('SELECT * FROM get_ebor_engagements_for_date($1, $2)', ['902063', '2026-04-26']);
  const xml = files['FRG_902063_202604260000.xml'];
  assert.equal(xml.split('\n').length - 5, ebor.rows.length);
  assert.match(xml, /902063,[^,]*,Late  Show &amp; Co,12\.00/);
  assert.equal(json.days[0].gross, Number(rts.rows.reduce((s, r) => s + Number(r.Gross), 0).toFixed(2)));
});

test('GET /api/box-office-reports: one day; bad dates and too-long ranges refused', async () => {
  const one = await get('from=2026-05-01');
  assert.equal(one.status, 200);
  assert.equal(one.json.fileName, 'box-office-2026-05-01.zip');
  assert.equal(one.json.days.length, 1);

  for (const q of ['', 'from=2026-02-30', 'from=05-01-2026', 'from=2026-05-02&to=2026-05-01', 'from=2026-01-01&to=2026-03-04']) {
    assert.equal((await get(q)).status, 400, q);
  }
  assert.equal((await get('from=2026-01-01&to=2026-03-03')).status, 200, '62 days is allowed');
});

test('GET /api/box-office-reports: edit permission; not view-only, door, filtered or signed-out logins', async () => {
  const editor = await ctx.insertUser({ username: 'bor-edit', permissions: { view: false, edit: true, checkIn: false, marketing: false, admin: false } });
  const viewer = await ctx.insertUser({ username: 'bor-view', permissions: { view: true, edit: false, checkIn: true, marketing: true, admin: true } });
  const filtered = await ctx.insertUser({ username: 'bor-filtered', permissions: { view: true, edit: true, checkIn: true }, dataFilter: { datafilters: [{ eventContains: 'jazz' }] } });
  assert.equal((await get('from=2026-05-01', editor.token)).status, 200);
  assert.equal((await get('from=2026-05-01', viewer.token)).status, 403);
  assert.equal((await get('from=2026-05-01', filtered.token)).status, 403);
  assert.equal((await ctx.request('GET', '/api/box-office-reports?from=2026-05-01', {})).status, 401);
});
