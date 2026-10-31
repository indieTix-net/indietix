import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from '../src/index.mjs';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';

const { Client } = pg;

test('setupTestDatabase/teardownTestDatabase: the convenience wrapper returns a ready, named database', async () => {
  const { dbConfig, containerName } = await setupTestDatabase({ dbName: 'harness_convenience_test' });
  try {
    assert.equal(dbConfig.database, 'harness_convenience_test');
    const client = new Client(dbConfig);
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
  } finally {
    await teardownTestDatabase(containerName);
  }
});

test('end-to-end: a real IndieTix schema, built via clientSetup-Teardown\'s exported createDatabaseObjects, actually works', async () => {
  const { dbConfig, containerName } = await setupTestDatabase({ dbName: 'harness_schema_test' });
  try {
    await createDatabaseObjects(dbConfig, 'harness_schema_test', 69938, 'Test Theatre', 'TT');

    const client = new Client({ ...dbConfig, database: 'harness_schema_test' });
    await client.connect();

    // The core tables exist...
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    const tableNames = tables.rows.map(r => r.table_name);
    for (const expected of ['Client', 'Order', 'QRCodeProduct', 'QRCodeProductToOrder', 'Customer', 'SmsConsent']) {
      assert.ok(tableNames.includes(expected), `expected table "${expected}" to exist, got: ${tableNames.join(', ')}`);
    }

    // ...and the box-office reporting function exists and actually runs
    // (this is exactly the kind of real-engine-only correctness this
    // whole package exists to make testable).
    const bdorResult = await client.query(`SELECT * FROM bdor_for_date('2026-01-01')`);
    assert.equal(bdorResult.rows.length, 0, 'no tickets sold yet, but the function must run without error');

    await client.end();
  } finally {
    await teardownTestDatabase(containerName);
  }
});
