import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects, insertClientRecord } from '../src/index.js';

const { Client } = pg;

// Per-venue values createDatabaseObjects bakes into bdor_for_date (the
// shared src/migrations.sql reads the same three from each venue's config).
const THEATER_ID = 69938;
const THEATER_NAME = 'Test Theatre';
const FILM_CODE_PREFIX = 'TT';

let dbConfig, containerName, client;

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'client_setup_teardown_test' }));
  await createDatabaseObjects(dbConfig, 'client_setup_teardown_test', THEATER_ID, THEATER_NAME, FILM_CODE_PREFIX);
  client = new Client(dbConfig);
  await client.connect();
  // The report's tax rate and screen numbers come from the venue's Client
  // Settings; this venue includes 9.3% tax and numbers its "little" room 2.
  await insertClientRecord(dbConfig, 'client_setup_teardown_test', {
    username: 'client_setup_teardown_test', clientSecret: 's', contactName: 'Test', clientEmail: 't@example.com',
    square_access_token: 't', square_signature_key: 'k', sender_email: 'n@example.com',
    theater_id: String(THEATER_ID), theater_name: THEATER_NAME, film_code_prefix: FILM_CODE_PREFIX, s3_bucket_prefix: 'indietix-'
  });
  await setReportSettings({ SALES_TAX_RATE: '9.3', SCREEN_NUMBERS: { little: '2' } });
});

after(async () => {
  await client.end();
  await teardownTestDatabase(containerName);
});

test('createDatabaseObjects: creates every table this schema depends on', async () => {
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  const tableNames = result.rows.map(r => r.table_name);
  const expected = [
    'Client', 'Order', 'QRCodeProduct', 'QRCodeProductToOrder',
    'SkeletonKey', 'SkeletonKeyUsage', 'Users', 'Customer', 'SmsConsent',
    'SmsOutboundLog', 'MarketingSchedule', 'MarketingPost', 'MarketingEmailContact'
  ];
  for (const name of expected) {
    assert.ok(tableNames.includes(name), `missing table "${name}"`);
  }
});

test('createDatabaseObjects: creates every function and view this schema depends on', async () => {
  const functions = await client.query(
    `SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'`
  );
  const functionNames = functions.rows.map(r => r.routine_name);
  for (const name of ['safe_to_timestamp', 'bdor_for_date', 'get_bdor_grouped_for_date', 'get_ebor_engagements_for_date']) {
    assert.ok(functionNames.includes(name), `missing function "${name}"`);
  }

  const views = await client.query(
    `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`
  );
  assert.ok(views.rows.some(r => r.table_name === 'OrderProductView'), 'missing OrderProductView');
});

// ---------------------------------------------------------------------------
// bdor_for_date -- the box-office reporting function. Real revenue data
// flows from this into DailyPgQueryAndSftp's feeds to distributors, so
// every status branch gets its own explicit test rather than relying on
// a "looks right" read of the SQL.
// ---------------------------------------------------------------------------

let ticketCounter = 0;

/**
 * Inserts a minimal valid QRCodeProduct row, overriding just what a test
 * cares about. Each call gets a unique QRCode (unique index) and, unless
 * overridden, its own report date so tests don't interfere with each other
 * without needing to truncate between them.
 */
async function insertTicket(overrides = {}) {
  ticketCounter += 1;
  const defaults = {
    QRCode: `TEST-QR-${ticketCounter}`,
    ExpirationDate: '2099-01-01',
    ProductDate: `2026-0${(ticketCounter % 9) + 1}-15 19:30:00`,
    ProductName: 'Test Movie',
    ProductLocation: 'Main Auditorium',
    ProductType: 'Movie',
    ProductDetails: 'Adult: Sun 01-15-2026 7:30 PM',
    ProductPrice: 12.50,
    ProductID: 'SQUARE-ITEM-1',
    ProductVenue: 'Main Theatre',
    ProductSeatCode: 'Adult',
    Status: 'valid'
  };
  const row = { ...defaults, ...overrides };
  await client.query(
    `INSERT INTO "QRCodeProduct"
      ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation",
       "ProductType", "ProductDetails", "ProductPrice", "ProductID", "ProductVenue",
       "ProductSeatCode", "Status")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [row.QRCode, row.ExpirationDate, row.ProductDate, row.ProductName, row.ProductLocation,
     row.ProductType, row.ProductDetails, row.ProductPrice, row.ProductID, row.ProductVenue,
     row.ProductSeatCode, row.Status]
  );
  return row;
}

async function setReportSettings(settings) {
  await client.query(`UPDATE "Client" SET configuration = (configuration::jsonb || $1::jsonb)::json`, [JSON.stringify(settings)]);
}

async function bdorFor(reportDate) {
  const result = await client.query(`SELECT * FROM bdor_for_date($1)`, [reportDate]);
  return result.rows;
}

test('bdor_for_date: a valid ticket reports full Gross/Net/Tax, Sold=1, Refunded=0', async () => {
  const row = await insertTicket({ ProductDate: '2026-02-01 19:00:00', ProductPrice: 10.93, Status: 'valid' });
  const [report] = await bdorFor('2026-02-01');

  assert.equal(Number(report.Gross), 10.93);
  // Net = Gross / (1 + SALES_TAX_RATE/100) = 10.93 / 1.093, rounded to 2 decimals.
  assert.equal(Number(report.Net), 10.00);
  assert.equal(Number(report.Tax), 0.93);
  assert.equal(report.Sold, 1);
  assert.equal(report.Refunded, 0);
});

test('bdor_for_date: a refunded ticket reports zero Gross/Net/Tax/Sold but Refunded=1', async () => {
  await insertTicket({ ProductDate: '2026-02-02 19:00:00', ProductPrice: 10.93, Status: 'refunded' });
  const [report] = await bdorFor('2026-02-02');

  assert.equal(Number(report.Gross), 0);
  assert.equal(Number(report.Net), 0);
  assert.equal(Number(report.Tax), 0);
  assert.equal(report.Sold, 0);
  assert.equal(report.Refunded, 1);
});

test('bdor_for_date: a transferred ticket (the OLD, superseded row) reports all zeros -- not even Refunded', async () => {
  await insertTicket({ ProductDate: '2026-02-03 19:00:00', ProductPrice: 10.93, Status: 'transferred' });
  const [report] = await bdorFor('2026-02-03');

  assert.equal(Number(report.Gross), 0);
  assert.equal(Number(report.Net), 0);
  assert.equal(Number(report.Tax), 0);
  assert.equal(report.Sold, 0);
  assert.equal(report.Refunded, 0, 'a transfer is not a refund -- no money came back');
});

test('bdor_for_date: a transferred ticket plus its replacement nets out to exactly one real sale', async () => {
  // This is the actual real-world shape: the old row gets marked
  // 'transferred', a brand new row carries the same seat/showtime forward
  // under a new QR code. The report for that showtime should show exactly
  // one sale, not zero and not two.
  const reportDate = '2026-02-04';
  await insertTicket({ QRCode: 'OLD-TRANSFERRED', ProductDate: `${reportDate} 19:00:00`, ProductPrice: 10.93, Status: 'transferred' });
  await insertTicket({ QRCode: 'NEW-AFTER-TRANSFER', ProductDate: `${reportDate} 19:00:00`, ProductPrice: 10.93, Status: 'valid' });

  const rows = await bdorFor(reportDate);
  const totalSold = rows.reduce((sum, r) => sum + r.Sold, 0);
  const totalGross = rows.reduce((sum, r) => sum + Number(r.Gross), 0);

  assert.equal(totalSold, 1, 'exactly one real sale, not double-counted and not dropped');
  assert.equal(totalGross, 10.93);
});

test('bdor_for_date: a cancelled ticket reports all zeros, same as transferred -- not a refund either', async () => {
  // Fixed 2026-10-25: the order-cancellation feature in QRScanner/src/
  // app.mjs (around line 3548) sets QRCodeProduct.Status = 'cancelled'
  // when a whole order is cancelled -- a real, reachable status this
  // function previously had no idea about, so a cancelled ticket used to
  // be counted as a full-price sale. Found while writing this suite.
  await insertTicket({ ProductDate: '2026-02-05 19:00:00', ProductPrice: 10.93, Status: 'cancelled' });
  const [report] = await bdorFor('2026-02-05');

  assert.equal(Number(report.Gross), 0);
  assert.equal(Number(report.Net), 0);
  assert.equal(Number(report.Tax), 0);
  assert.equal(report.Sold, 0);
  assert.equal(report.Refunded, 0, 'a cancellation is not a refund -- no money necessarily came back');
});

test('bdor_for_date: only ProductType = \'Movie\' rows are reported (bar/concessions excluded)', async () => {
  const reportDate = '2026-02-06';
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductType: 'Movie', ProductPrice: 10 });
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductType: 'Concession', ProductPrice: 999 });

  const rows = await bdorFor(reportDate);
  assert.equal(rows.length, 1, 'only the Movie-type row should appear');
  assert.equal(Number(rows[0].Gross), 10);
});

test('QRCodeProduct.ProductDate is NOT NULL -- bdor_for_date\'s own "IS NOT NULL" filter is defensive, not reachable today', async () => {
  // bdor_for_date explicitly filters out NULL ProductDate rows, but the
  // column itself is NOT NULL at the schema level -- confirming that here
  // so nobody "fixes" the function's defensive check thinking it handles a
  // real case, and so a future schema change that loosens this constraint
  // doesn't silently change bdor_for_date's behavior without anyone
  // noticing the function was relying on it.
  await assert.rejects(
    () => client.query(
      `INSERT INTO "QRCodeProduct"
        ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation",
         "ProductType", "ProductDetails", "ProductID", "Status")
       VALUES ('NO-PRODUCT-DATE', '2099-01-01', NULL, 'Test Movie', 'Main', 'Movie', 'details', 'ITEM', 'valid')`
    ),
    /null value in column "ProductDate".*violates not-null constraint/
  );
});

test('bdor_for_date: matches on the Chicago-wall-clock calendar date regardless of time of day', async () => {
  const reportDate = '2026-02-07';
  await insertTicket({ ProductDate: `${reportDate} 00:05:00`, ProductPrice: 5 });
  await insertTicket({ ProductDate: `${reportDate} 23:55:00`, ProductPrice: 7 });

  const rows = await bdorFor(reportDate);
  assert.equal(rows.length, 2);
});

test('bdor_for_date: Film Code is the configured prefix + first 6 chars of md5(ProductName)', async () => {
  const reportDate = '2026-02-08';
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductName: 'Digger (2026)' });
  const [report] = await bdorFor(reportDate);

  const crypto = await import('node:crypto');
  const expectedHash = crypto.createHash('md5').update('Digger (2026)').digest('hex').substring(0, 6);
  assert.equal(report['Film Code'], FILM_CODE_PREFIX + expectedHash);
});

test('bdor_for_date: Screen comes from SCREEN_NUMBERS ("little" -> 2, case-insensitive), else "1"', async () => {
  const reportDate = '2026-02-09';
  await insertTicket({ QRCode: 'MAIN-SCREEN', ProductDate: `${reportDate} 19:00:00`, ProductVenue: 'Main Theatre' });
  await insertTicket({ QRCode: 'LITTLE-SCREEN', ProductDate: `${reportDate} 19:00:00`, ProductVenue: 'The Little Theatre' });

  const rows = await bdorFor(reportDate);
  const main = rows.find(r => r.Title === 'Test Movie' && r.Screen === '1');
  const little = rows.find(r => r.Screen === '2');
  assert.ok(main, 'expected a Screen=1 row for the main venue');
  assert.ok(little, 'expected a Screen=2 row for the "Little" venue');
});

test('bdor_for_date: a free ticket (price 0) reports Sold=0, not a sale', async () => {
  await insertTicket({ ProductDate: '2026-02-10 19:00:00', ProductPrice: 0, Status: 'valid' });
  const [report] = await bdorFor('2026-02-10');
  assert.equal(report.Sold, 0);
  assert.equal(Number(report.Gross), 0);
});

test('get_bdor_grouped_for_date: sums multiple tickets for the same showtime/ticket-type into one row', async () => {
  const reportDate = '2026-03-01';
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductSeatCode: 'Adult', ProductPrice: 10 });
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductSeatCode: 'Adult', ProductPrice: 10 });
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductSeatCode: 'Child', ProductPrice: 8 });

  const result = await client.query(
    `SELECT * FROM get_bdor_grouped_for_date($1, $2, $3)`,
    [String(THEATER_ID), THEATER_NAME, reportDate]
  );
  const adultRow = result.rows.find(r => r['Ticket Type'] === 'Adult');
  const childRow = result.rows.find(r => r['Ticket Type'] === 'Child');

  assert.equal(Number(adultRow.Sold), 2);
  assert.equal(Number(adultRow.Gross), 20);
  assert.equal(Number(childRow.Sold), 1);
  assert.equal(Number(childRow.Gross), 8);
});

test('get_ebor_engagements_for_date: rolls up to one row per Title regardless of ticket type', async () => {
  const reportDate = '2026-03-02';
  await insertTicket({ ProductDate: `${reportDate} 14:00:00`, ProductName: 'Rollup Movie', ProductSeatCode: 'Adult', ProductPrice: 10 });
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductName: 'Rollup Movie', ProductSeatCode: 'Child', ProductPrice: 8 });
  await insertTicket({ ProductDate: `${reportDate} 19:00:00`, ProductName: 'Other Movie', ProductPrice: 12 });

  const result = await client.query(
    `SELECT * FROM get_ebor_engagements_for_date($1, $2)`,
    ['TEST-THEATRE-NO', reportDate]
  );
  const rollup = result.rows.find(r => r.Title === 'Rollup Movie');
  assert.equal(Number(rollup.Gross), 18, 'both showtimes of the same title combine into one row');
  assert.equal(result.rows.length, 2, 'two distinct titles -> two rows');
});

test('safe_to_timestamp: NULL in, NULL out', async () => {
  const result = await client.query(`SELECT safe_to_timestamp(NULL) AS ts`);
  assert.equal(result.rows[0].ts, null);
});

test('safe_to_timestamp: a valid timestamp string parses correctly', async () => {
  const result = await client.query(`SELECT safe_to_timestamp('2026-05-17 14:30:00') AS ts`);
  assert.ok(result.rows[0].ts instanceof Date);
});

test('safe_to_timestamp: an unparseable string returns NULL instead of throwing', async () => {
  const result = await client.query(`SELECT safe_to_timestamp('not a timestamp at all') AS ts`);
  assert.equal(result.rows[0].ts, null);
});

test('OrderProductView: joins QRCodeProduct to its Order through the junction table', async () => {
  const order = await client.query(
    `INSERT INTO "Order" ("OrderID", "EmailAddress", "FirstName", "LastName")
     VALUES ('ORDER-VIEW-TEST', 'test@example.com', 'Jane', 'Doe') RETURNING "ID"`
  );
  const ticket = await insertTicket({ QRCode: 'VIEW-TEST-QR' });
  const product = await client.query(`SELECT "ID" FROM "QRCodeProduct" WHERE "QRCode" = $1`, [ticket.QRCode]);
  await client.query(
    `INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`,
    [product.rows[0].ID, order.rows[0].ID]
  );

  const result = await client.query(
    `SELECT * FROM "OrderProductView" WHERE "QRCode" = $1`,
    ['VIEW-TEST-QR']
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].EmailAddress, 'test@example.com');
  assert.equal(result.rows[0].FirstName, 'Jane');
});

// ---- tax rate and screen numbers from Client Settings ----

test('bdor_for_date: with no SALES_TAX_RATE, Net is the full Gross and Tax is 0', async () => {
  await setReportSettings({ SALES_TAX_RATE: '' });
  try {
    await insertTicket({ QRCode: 'NO-TAX', ProductDate: '2026-04-21 19:00:00', ProductPrice: 10.93 });
    const [report] = await bdorFor('2026-04-21');
    assert.equal(Number(report.Gross), 10.93);
    assert.equal(Number(report.Net), 10.93);
    assert.equal(Number(report.Tax), 0);
  } finally {
    await setReportSettings({ SALES_TAX_RATE: '9.3' });
  }
});

test('bdor_for_date: a malformed SALES_TAX_RATE counts as no tax instead of breaking the report', async () => {
  await setReportSettings({ SALES_TAX_RATE: '9.3%' });
  try {
    await insertTicket({ QRCode: 'BAD-TAX', ProductDate: '2026-04-22 19:00:00', ProductPrice: 10.93 });
    const [report] = await bdorFor('2026-04-22');
    assert.equal(Number(report.Net), 10.93);
  } finally {
    await setReportSettings({ SALES_TAX_RATE: '9.3' });
  }
});

test('bdor_for_date: a settings change applies on the next run, and the longest SCREEN_NUMBERS match wins', async () => {
  await setReportSettings({ SALES_TAX_RATE: '5', SCREEN_NUMBERS: { room: '2', 'room b': '3' } });
  try {
    await insertTicket({ QRCode: 'ROOM-A', ProductDate: '2026-04-23 19:00:00', ProductPrice: 10.50, ProductVenue: 'Room A' });
    await insertTicket({ QRCode: 'ROOM-B', ProductDate: '2026-04-23 19:00:00', ProductPrice: 10.50, ProductVenue: 'Room B' });
    await insertTicket({ QRCode: 'LOBBY', ProductDate: '2026-04-23 19:00:00', ProductPrice: 10.50, ProductVenue: 'Lobby' });
    const rows = await bdorFor('2026-04-23');
    assert.deepEqual(rows.map(r => r.Screen).sort(), ['1', '2', '3']);
    assert.equal(Number(rows[0].Net), 10.00);
  } finally {
    await setReportSettings({ SALES_TAX_RATE: '9.3', SCREEN_NUMBERS: { little: '2' } });
  }
});
