import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgresContainer, stopPostgresContainer } from '../src/docker.mjs';
import { createDatabase, dropDatabase } from '../src/database.mjs';

const { Client } = pg;

let adminConfig, containerName;

before(async () => {
  ({ dbConfig: adminConfig, containerName } = await startPostgresContainer());
});

after(async () => {
  await stopPostgresContainer(containerName);
});

test('createDatabase: creates a real, connectable, empty database', async () => {
  await createDatabase(adminConfig, 'harness_test_create');
  const client = new Client({ ...adminConfig, database: 'harness_test_create' });
  await client.connect();
  const result = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public'`
  );
  assert.equal(result.rows[0].cnt, 0);
  await client.end();
});

test('dropDatabase: removes it, and tolerates an active connection by terminating it first', async () => {
  await createDatabase(adminConfig, 'harness_test_drop');
  const client = new Client({ ...adminConfig, database: 'harness_test_drop' });
  await client.connect();
  // Deliberately leave this connection open -- dropDatabase must terminate
  // it itself; Postgres refuses to DROP DATABASE with active connections.
  // pg emits an 'error' event on the client when the server kills its
  // connection out from under it -- expected here, so swallow it rather
  // than let it surface as an unhandled error after the test completes.
  client.on('error', () => {});

  await dropDatabase(adminConfig, 'harness_test_drop');

  const admin = new Client(adminConfig);
  await admin.connect();
  const result = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    ['harness_test_drop']
  );
  assert.equal(result.rows.length, 0);
  await admin.end();
});

test('dropDatabase: a nonexistent database is a no-op, not an error', async () => {
  await assert.doesNotReject(() => dropDatabase(adminConfig, 'harness_test_never_created'));
});

test('createDatabase/dropDatabase: reject unsafe identifiers rather than interpolating them', async () => {
  await assert.rejects(() => createDatabase(adminConfig, 'bad; DROP TABLE x'), /Unsafe database identifier/);
  await assert.rejects(() => dropDatabase(adminConfig, '"quoted"'), /Unsafe database identifier/);
});
