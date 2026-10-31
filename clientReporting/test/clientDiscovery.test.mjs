import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgresContainer, stopPostgresContainer, createDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getAllClientDatabases, getClientsFromDatabase, getAllClientsFromAllDatabases } = require('../src/index.js');

const { Client } = pg;

let adminConfig, containerName;

async function seedClient(dbName, { theaterId, theaterName, filmCode, clientId, status = 'active' }) {
  await createDatabase(adminConfig, dbName);
  await createDatabaseObjects({ ...adminConfig, database: dbName }, dbName, theaterId, theaterName, filmCode);
  const client = new Client({ ...adminConfig, database: dbName });
  await client.connect();
  await client.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "Status", "configuration")
     VALUES ($1, 'super-secret-value', 'Contact', 'contact@example.com', $2, $3)`,
    [clientId, status, JSON.stringify({ SQUARE_ACCESS_TOKEN: 'real-square-token', WEB_HEADER_COMPANY: clientId })]
  );
  await client.end();
}

before(async () => {
  ({ dbConfig: adminConfig, containerName } = await startPostgresContainer());

  await seedClient('client_gamma', { theaterId: 1, theaterName: 'Gamma', filmCode: 'GG', clientId: 'GAMMA1234567', status: 'active' });
  await seedClient('client_delta', { theaterId: 2, theaterName: 'Delta', filmCode: 'DD', clientId: 'DELTA1234567', status: 'inactive' });

  // A real "indietix" maintenance database -- discovery must exclude this
  // by name, distinct from the generic "no Client table" skip.
  await createDatabase(adminConfig, 'indietix');

  await createDatabase(adminConfig, 'no_client_table_here');
});

after(async () => {
  await stopPostgresContainer(containerName);
});

test('getAllClientDatabases: excludes the indietix superuser database by name, not just by missing-Client-table', async () => {
  const databases = await getAllClientDatabases(adminConfig);
  assert.ok(!databases.includes('indietix'), 'indietix must be excluded even though it could theoretically have a Client table');
  assert.ok(databases.includes('client_gamma'));
  assert.ok(databases.includes('client_delta'));
  assert.ok(databases.includes('no_client_table_here'), 'still discovered -- getClientsFromDatabase is what filters it out next');
});

test('getClientsFromDatabase: returns the client row, tagged with source_database, from a real client database', async () => {
  const rows = await getClientsFromDatabase('client_gamma', adminConfig);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_database, 'client_gamma');
  assert.equal(rows[0].clientid, 'GAMMA1234567');
  assert.equal(rows[0].clientsecret, 'super-secret-value', 'raw query still returns it -- redaction happens in the handler, not here');
  assert.equal(rows[0].configuration.SQUARE_ACCESS_TOKEN, 'real-square-token');
});

test('getClientsFromDatabase: returns an empty array for a database with no Client table, not an error', async () => {
  const rows = await getClientsFromDatabase('no_client_table_here', adminConfig);
  assert.deepEqual(rows, []);
});

test('getClientsFromDatabase: returns an empty array for a database that doesn\'t exist, not a thrown error', async () => {
  const rows = await getClientsFromDatabase('this_does_not_exist_at_all', adminConfig);
  assert.deepEqual(rows, []);
});

test('getAllClientsFromAllDatabases: consolidates real clients across databases, skips indietix and the Client-table-less one', async () => {
  const all = await getAllClientsFromAllDatabases(adminConfig);
  const ids = all.map(c => c.clientid);
  assert.ok(ids.includes('GAMMA1234567'));
  assert.ok(ids.includes('DELTA1234567'));
  assert.equal(all.length, 2);
});
