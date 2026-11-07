import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgresContainer, stopPostgresContainer } from '../src/docker.mjs';

const { Client } = pg;

test('startPostgresContainer: returns a usable, ready connection config', async () => {
  const { dbConfig, containerName } = await startPostgresContainer();
  try {
    assert.equal(dbConfig.database, 'postgres');
    assert.equal(dbConfig.host, '127.0.0.1');
    assert.ok(dbConfig.port > 0);
    assert.match(containerName, /^test-db-harness-/);

    const client = new Client(dbConfig);
    await client.connect();
    const result = await client.query('SELECT 1 AS one');
    assert.equal(result.rows[0].one, 1);
    await client.end();
  } finally {
    await stopPostgresContainer(containerName);
  }
});

test('startPostgresContainer: two containers in the same run get different ports', async () => {
  const a = await startPostgresContainer();
  const b = await startPostgresContainer();
  try {
    assert.notEqual(a.dbConfig.port, b.dbConfig.port);
    assert.notEqual(a.containerName, b.containerName);
  } finally {
    await stopPostgresContainer(a.containerName);
    await stopPostgresContainer(b.containerName);
  }
});

// Several test files start containers at the same moment (node --test runs
// files in parallel); none may fail on a port another one took.
test('startPostgresContainer: many containers started at once all come up on their own ports', async () => {
  const started = await Promise.allSettled(Array.from({ length: 6 }, () => startPostgresContainer()));
  try {
    const failures = started.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    assert.deepEqual(failures, []);
    const ports = started.map((r) => r.value.dbConfig.port);
    assert.equal(new Set(ports).size, ports.length);
  } finally {
    await Promise.all(started.filter((r) => r.status === 'fulfilled').map((r) => stopPostgresContainer(r.value.containerName)));
  }
});

test('stopPostgresContainer: actually removes the container (started with --rm)', async () => {
  const { dbConfig, containerName } = await startPostgresContainer();
  await stopPostgresContainer(containerName);

  const client = new Client({ ...dbConfig, connectionTimeoutMillis: 1000 });
  await assert.rejects(() => client.connect(), /./, 'should not be able to connect after teardown');
});
