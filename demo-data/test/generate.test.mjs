import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects, insertClientRecord } from '../../clientSetup-Teardown/src/index.js';
import { generateDemo, toSql, resolveOptions } from '../src/generate.mjs';

const CLIENT = 'demo_data_test';
const NOW = new Date('2026-11-08T18:00:00Z');
const options = { clientId: CLIENT, now: NOW, siteUrl: 'https://demo.example.com', staffPasswordHash: '$2b$10$staff', guestPasswordHash: '$2b$10$guest' };
// At least as much as a real busy single venue (Liberty Hall, November 2026).
const AT_LEAST = { QRCodeProduct: 6810, Order: 4136, Customer: 735, SmsConsent: 103, SmsOutboundLog: 50, MarketingPost: 22 };

let demo, dbConfig, containerName, client;

before(async () => {
  demo = generateDemo(options);
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: CLIENT }));
  await createDatabaseObjects(dbConfig, CLIENT, demo.venue.theaterId, demo.venue.name, 'MQ');
  await insertClientRecord(dbConfig, CLIENT, {
    username: CLIENT, clientSecret: 's', contactName: 'Demo', clientEmail: 'demo@example.com',
    square_access_token: 'none', square_signature_key: 'none', sender_email: 'demo@example.com',
    theater_id: demo.venue.theaterId, theater_name: demo.venue.name, film_code_prefix: 'MQ'
  });
  client = new pg.Client(dbConfig);
  await client.connect();
});
after(async () => { await client?.end(); await teardownTestDatabase(containerName); });

const load = async (d) => { for (const sql of toSql(d)) await client.query(sql); };

test('the same seed and date give the same venue', () => {
  const again = generateDemo(options);
  assert.equal(JSON.stringify(again.tables), JSON.stringify(demo.tables));
});

test('it is at least as big as a real venue', () => {
  for (const [table, min] of Object.entries(AT_LEAST)) {
    assert.ok(demo.tables[table].length >= min, `${table}: ${demo.tables[table].length} < ${min}`);
  }
});

test('every person is made up: reserved email domains, fictional phone numbers, documentation IPs', () => {
  const emails = [], phones = [], ips = [];
  for (const rows of [demo.tables.Order, demo.tables.QRCodeProduct, demo.tables.Customer]) {
    for (const r of rows) { if (r.EmailAddress || r.Email) emails.push(r.EmailAddress || r.Email); if (r.PhoneNumber) phones.push(r.PhoneNumber); }
  }
  for (const r of demo.tables.SmsConsent) { phones.push(r.PhoneNumber); ips.push(r.IPAddress); }
  for (const r of demo.tables.SmsOutboundLog) phones.push(r.PhoneNumber);
  for (const r of demo.tables.MarketingEmailContact) emails.push(r.Email);
  for (const r of demo.tables.Users) emails.push(r.Email);
  for (const r of demo.tables.SkeletonKeyUsage) ips.push(r.ipAddress);
  assert.ok(emails.length > 1000 && phones.length > 1000);
  for (const e of emails) assert.match(e, /@example\.(com|org|net)$/);
  for (const p of phones) assert.match(p, /^\+1\d{3}55501\d{2}$/);
  for (const ip of ips) assert.match(ip, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
  // Nothing is generated with the Liberty Hall venue's names.
  assert.doesNotMatch(JSON.stringify(demo), /Liberty Hall|libertyhall|Lawrence/i);
});

test('loads into a freshly onboarded venue database, links intact', async () => {
  await load(demo);
  const count = async (t) => (await client.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
  for (const [table, rows] of Object.entries(demo.tables)) assert.equal(await count(table), rows.length, table);
  const orphans = await client.query(`
    SELECT
      (SELECT count(*)::int FROM "QRCodeProduct" p WHERE NOT EXISTS (SELECT 1 FROM "QRCodeProductToOrder" l WHERE l."QRCodeProductID" = p."ID")) AS unlinked_tickets,
      (SELECT count(*)::int FROM "QRCodeProductToOrder" l WHERE NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."ID" = l."OrderID")) AS missing_orders,
      (SELECT count(*)::int FROM "Order" o WHERE o."CustomerID" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c."ID" = o."CustomerID")) AS missing_customers,
      (SELECT count(*)::int FROM "SmsConsent" s WHERE NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c."ID" = s."CustomerID")) AS consent_without_customer`);
  assert.deepEqual(orphans.rows[0], { unlinked_tickets: 0, missing_orders: 0, missing_customers: 0, consent_without_customer: 0 });
  // The view operators query works over the data.
  const view = await client.query(`SELECT count(*)::int AS n FROM "OrderProductView"`);
  assert.equal(view.rows[0].n, demo.tables.QRCodeProduct.length);
});

test('the settings are merged in, and the box-office report has rows for a past Saturday', async () => {
  const config = (await client.query(`SELECT "configuration"::jsonb AS c FROM "Client"`)).rows[0].c;
  assert.equal(config.WEB_HEADER_COMPANY, 'The Marquee');
  assert.equal(config.SEND_SMS, 'false');
  assert.equal(config.SQUARE_ACCESS_TOKEN, ''); // not connected to Square
  assert.equal(config.FILM_CODE_PREFIX, 'MQ'); // onboarding's other values are kept
  const saturday = demo.tables.QRCodeProduct.find(t => t.ProductType === 'Movie' && new Date(t.ProductDate.replace(' ', 'T') + 'Z').getUTCDay() === 6 && t.ProductDate < '2026-10-01').ProductDate.slice(0, 10);
  const report = await client.query('SELECT * FROM bdor_for_date($1)', [saturday]);
  assert.ok(report.rows.length > 0);
  assert.ok(report.rows.some(r => r.Screen === '2'), 'Studio shows are screen 2');
});

test('loading again resets the venue (a guest\'s changes are gone)', async () => {
  await client.query(`UPDATE "QRCodeProduct" SET "Status" = 'deleted'`);
  await client.query(`INSERT INTO "Users" ("Username", "Password", "Email") VALUES ('made-by-guest', 'x', 'g@example.com')`);
  await load(demo);
  const { rows } = await client.query(`SELECT
      (SELECT count(*)::int FROM "QRCodeProduct" WHERE "Status" = 'deleted') AS deleted,
      (SELECT count(*)::int FROM "Users" WHERE "Username" = 'made-by-guest') AS extra_user`);
  assert.deepEqual(rows[0], { deleted: 0, extra_user: 0 });
  // New rows get fresh IDs after the load.
  const next = await client.query(`INSERT INTO "Order" ("OrderID") VALUES ('after-load') RETURNING "ID"`);
  assert.equal(next.rows[0].ID, demo.tables.Order.length + 1);
});

test('a venue missing a newer table (onboarded by older code) still loads', async () => {
  await client.query('DROP TABLE "PrivacyRequest"');
  await load(demo);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM "Order"`);
  assert.equal(rows[0].n, demo.tables.Order.length);
});

test('upcoming shows have presales but nothing is checked in or sold after "now"', () => {
  const upcoming = demo.tables.QRCodeProduct.filter(t => t.ProductDate > '2026-11-09');
  assert.ok(upcoming.length > 20);
  assert.ok(upcoming.every(t => !t.CheckedIn));
  assert.ok(demo.tables.Order.every(o => o.CreatedDate <= '2026-11-08 18:00:00'));
});

// ---- size options ----

const pastPerShow = (d, type) => {
  const past = d.tables.QRCodeProduct.filter(t => t.ProductType === type && t.ProductDate < '2026-11-08');
  return past.length / new Set(past.map(t => t.ProductName + t.ProductDate)).size;
};

test('kind: cinema only or live only', () => {
  const cinema = generateDemo({ ...options, kind: 'cinema' });
  assert.ok(cinema.tables.QRCodeProduct.every(t => t.ProductType === 'Movie'));
  const live = generateDemo({ ...options, kind: 'live' });
  assert.ok(live.tables.QRCodeProduct.every(t => t.ProductType === 'Live'));
  assert.ok(live.summary.showtimes.live > demo.summary.showtimes.live, 'a live-only venue has more live nights');
});

test('tickets per movie and per live event set the averages; months sets the history', () => {
  const d = generateDemo({ ...options, ticketsPerMovie: 30, ticketsPerLive: 50, months: 6 });
  assert.ok(Math.abs(pastPerShow(d, 'Movie') - 30) < 1);
  assert.ok(Math.abs(pastPerShow(d, 'Live') - 50) < 1);
  const first = d.tables.QRCodeProduct.map(t => t.ProductDate).sort()[0];
  assert.ok(first > '2026-05-01' && first < '2026-05-20', first);
});

test('a total ticket count is hit exactly; customers exactly; orders per customer closely', () => {
  const d = generateDemo({ ...options, tickets: 20000, customers: 3000, ordersPerCustomer: 3 });
  assert.equal(d.tables.QRCodeProduct.length, 20000);
  assert.equal(d.summary.customers, 3000);
  assert.ok(Math.abs(d.summary.ordersPerCustomer - 3) < 0.25, String(d.summary.ordersPerCustomer));
  const small = generateDemo({ ...options, kind: 'live', months: 3, tickets: 500, customers: 100, ordersPerCustomer: 2 });
  assert.equal(small.tables.QRCodeProduct.length, 500);
  assert.equal(small.summary.customers, 100);
});

test('bad sizes are refused with a readable message', () => {
  assert.throws(() => resolveOptions({ kind: 'movies' }), /kind must be cinema, live or both/);
  assert.throws(() => resolveOptions({ customers: -5 }), /customers must be a whole number/);
  assert.throws(() => resolveOptions({ months: 0 }), /months must be/);
  assert.throws(() => generateDemo({ ...options, tickets: 1000, customers: 5000, ordersPerCustomer: 3 }), /orders need at least as many tickets/);
});
