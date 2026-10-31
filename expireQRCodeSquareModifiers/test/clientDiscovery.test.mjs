import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgresContainer, stopPostgresContainer, createDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { getAllClientDatabases, getClientConfiguration, getAllClientsWithConfigurations } from '../src/index.mjs';

const { Client } = pg;

// This Lambda discovers clients by querying pg_database across an entire
// Postgres cluster (the indietix superuser can see every database), so
// the realistic test fixture is genuinely multiple client databases in
// ONE container -- not one database per test file like most of this
// platform's other tests.
let adminConfig, containerName;

before(async () => {
  ({ dbConfig: adminConfig, containerName } = await startPostgresContainer());

  await createDatabase(adminConfig, 'client_alpha');
  await createDatabaseObjects({ ...adminConfig, database: 'client_alpha' }, 'client_alpha', 1, 'Alpha Theatre', 'AA');
  const alphaClient = new Client({ ...adminConfig, database: 'client_alpha' });
  await alphaClient.connect();
  await alphaClient.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ('client_alpha', 'secret', 'Alpha', 'alpha@example.com', $1)`,
    [JSON.stringify({ SQUARE_ACCESS_TOKEN: 'alpha-token' })]
  );
  await alphaClient.end();

  await createDatabase(adminConfig, 'client_beta');
  await createDatabaseObjects({ ...adminConfig, database: 'client_beta' }, 'client_beta', 2, 'Beta Theatre', 'BB');
  const betaClient = new Client({ ...adminConfig, database: 'client_beta' });
  await betaClient.connect();
  await betaClient.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ('client_beta', 'secret', 'Beta', 'beta@example.com', $1)`,
    [JSON.stringify({ SQUARE_ACCESS_TOKEN: 'beta-token' })]
  );
  await betaClient.end();

  // A database that exists but was never set up as a real client (no
  // Client table at all) -- should be silently skipped, not an error.
  await createDatabase(adminConfig, 'not_a_real_client');
});

after(async () => {
  await stopPostgresContainer(containerName);
});

test('getAllClientDatabases: finds every non-system database, excluding postgres/template0/template1', async () => {
  const databases = await getAllClientDatabases(adminConfig);
  assert.ok(databases.includes('client_alpha'));
  assert.ok(databases.includes('client_beta'));
  assert.ok(databases.includes('not_a_real_client'));
  assert.ok(!databases.includes('postgres'));
  assert.ok(!databases.includes('template0'));
  assert.ok(!databases.includes('template1'));
});

test('getClientConfiguration: returns the configuration for a real client database', async () => {
  const config = await getClientConfiguration('client_alpha', adminConfig);
  assert.equal(config.clientId, 'client_alpha');
  assert.equal(config.configuration.SQUARE_ACCESS_TOKEN, 'alpha-token');
});

test('getClientConfiguration: returns null for a database with no Client table at all', async () => {
  const config = await getClientConfiguration('not_a_real_client', adminConfig);
  assert.equal(config, null);
});

test('getClientConfiguration: returns null for a database it can\'t connect to or query, rather than throwing', async () => {
  const config = await getClientConfiguration('this_database_does_not_exist', adminConfig);
  assert.equal(config, null);
});

test('getAllClientsWithConfigurations: discovers every real client, skips the one with no Client table', async () => {
  const clients = await getAllClientsWithConfigurations(adminConfig);
  const clientIds = clients.map(c => c.clientId);
  assert.ok(clientIds.includes('client_alpha'));
  assert.ok(clientIds.includes('client_beta'));
  assert.ok(!clientIds.includes('not_a_real_client'));
  assert.equal(clients.length, 2);
});
