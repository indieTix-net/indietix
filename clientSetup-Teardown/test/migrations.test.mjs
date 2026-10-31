import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects, insertClientRecord } from '../src/index.js';

const { Client } = pg;
const DB_NAME = 'migrations_test';
const MIGRATIONS = readFileSync(new URL('../src/migrations.sql', import.meta.url), 'utf8');

// A venue that isn't Liberty Hall, with an apostrophe in its name so the
// generated function body's quoting gets exercised.
const THEATER_ID = 54321;
const THEATER_NAME = "Joe's Cinema";
const FILM_CODE_PREFIX = 'JC';

let dbConfig, containerName, client;

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: DB_NAME }));
  await createDatabaseObjects(dbConfig, DB_NAME, THEATER_ID, THEATER_NAME, FILM_CODE_PREFIX);
  await insertClientRecord(dbConfig, DB_NAME, {
    username: 'JOESCINEMA',
    clientSecret: 'client-secret',
    contactName: 'Joe',
    clientEmail: 'joe@example.com',
    square_access_token: 'square-token',
    square_signature_key: 'square-sig-key',
    sender_email: 'noreply@example.com',
    theater_id: String(THEATER_ID),
    theater_name: THEATER_NAME,
    film_code_prefix: FILM_CODE_PREFIX,
    s3_bucket_prefix: 'indietix-'
  });
  client = new Client(dbConfig);
  await client.connect();
});

after(async () => {
  await client.end();
  await teardownTestDatabase(containerName);
});

async function bdorDefinition() {
  const { rows } = await client.query(`SELECT pg_get_functiondef('public.bdor_for_date(date)'::regprocedure) AS def`);
  return rows[0].def;
}

async function config() {
  const { rows } = await client.query('SELECT configuration FROM "Client" LIMIT 1');
  const c = rows[0].configuration;
  return typeof c === 'string' ? JSON.parse(c) : c;
}

test('migrations.sql: names no particular venue', () => {
  assert.doesNotMatch(MIGRATIONS, /Liberty Hall|M5E5N7KAHZA7Q|69938|'LH'::text/);
});

test('migrations.sql: runs on a fresh venue and rebuilds bdor_for_date with that venue\'s own values', async () => {
  await client.query(MIGRATIONS);
  const def = await bdorDefinition();
  assert.match(def, /54321 AS "TheatreID"/);
  assert.match(def, /'Joe''s Cinema'::text AS "Theatre Name"/);
  assert.match(def, /'JC'::text \|\| substring\(md5/);
  assert.match(def, /'refunded', 'transferred', 'cancelled'/, 'the later (2026-10-25) version wins');

  await client.query(`
    INSERT INTO "QRCodeProduct" ("QRCode", "ProductName", "ProductDate", "ExpirationDate", "ProductLocation",
                                 "ProductDetails", "ProductID", "ProductPrice", "ProductType", "Status")
    VALUES ('MIGTEST1', 'Test Film', '2026-11-01 19:30:00', '2026-11-02 00:00:00', 'Main Theater',
            'details', 'PID1', 10.93, 'Movie', 'valid')`);
  const { rows } = await client.query(`SELECT * FROM bdor_for_date('2026-11-01')`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TheatreID, THEATER_ID);
  assert.equal(rows[0]['Theatre Name'], THEATER_NAME);
  assert.match(rows[0]['Film Code'], /^JC[0-9a-f]{6}$/);
});

test('migrations.sql: is safe to re-run', async () => {
  await client.query(MIGRATIONS);
  assert.match(await bdorDefinition(), /54321 AS "TheatreID"/);
});

test('migrations.sql: a venue missing FILM_CODE_PREFIX gets the prefix already baked into its function', async () => {
  await client.query(`UPDATE "Client" SET configuration = (configuration::jsonb - 'FILM_CODE_PREFIX')::json`);
  assert.equal((await config()).FILM_CODE_PREFIX, undefined);
  await client.query(MIGRATIONS);
  assert.equal((await config()).FILM_CODE_PREFIX, FILM_CODE_PREFIX);
});

test('migrations.sql: a missing THEATER_ID stops with a clear error and leaves bdor_for_date alone', async () => {
  const before = await bdorDefinition();
  await client.query(`UPDATE "Client" SET configuration = (configuration::jsonb - 'THEATER_ID')::json`);
  await assert.rejects(client.query(MIGRATIONS), /THEATER_ID must be digits, got \(missing\)/);
  await client.query('ROLLBACK').catch(() => {});
  assert.equal(await bdorDefinition(), before);
  await client.query(`UPDATE "Client" SET configuration = (configuration::jsonb || '{"THEATER_ID": "54321"}'::jsonb)::json`);
});
