import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects, insertClientRecord } from '../src/index.js';

const { Client } = pg;
const DB_NAME = 'client_record_test';

let dbConfig, containerName, client;

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: DB_NAME }));
  await createDatabaseObjects(dbConfig, DB_NAME, 1, 'Test Theatre', 'TT');
  client = new Client(dbConfig);
  await client.connect();
});

after(async () => {
  await client.end();
  await teardownTestDatabase(containerName);
});

function clientData(overrides = {}) {
  return {
    username: 'CLIENTA',
    clientSecret: 'client-secret',
    contactName: 'Test Contact',
    clientEmail: 'contact@example.com',
    square_access_token: 'square-token',
    square_signature_key: 'square-sig-key',
    sender_email: 'noreply@example.com',
    theater_id: '000000',
    theater_name: 'Test Theatre',
    film_code_prefix: 'TT',
    s3_bucket_prefix: 'indietix-',
    ...overrides
  };
}

async function configFor(clientId) {
  const result = await client.query('SELECT configuration FROM "Client" WHERE "clientID" = $1', [clientId]);
  const config = result.rows[0].configuration;
  return typeof config === 'string' ? JSON.parse(config) : config;
}

test('insertClientRecord: webhook URL and location ID passed at onboarding land in the config', async () => {
  await insertClientRecord(dbConfig, DB_NAME, clientData({
    username: 'CLIENTWITHSQUARE',
    square_webhook_url: 'https://example.execute-api.us-west-1.amazonaws.com/webhook/square',
    square_location_id: 'LOC123'
  }));
  const config = await configFor('CLIENTWITHSQUARE');
  assert.equal(config.SQUARE_WEBHOOK_URL, 'https://example.execute-api.us-west-1.amazonaws.com/webhook/square');
  assert.equal(config.SQUARE_LOCATION_ID, 'LOC123');
  assert.equal(config.SQUARE_SIGNATURE_KEY, 'square-sig-key');
});

test('insertClientRecord: webhook URL and location ID stay blank when not passed', async () => {
  await insertClientRecord(dbConfig, DB_NAME, clientData({ username: 'CLIENTWITHOUTSQUARE' }));
  const config = await configFor('CLIENTWITHOUTSQUARE');
  assert.equal(config.SQUARE_WEBHOOK_URL, '');
  assert.equal(config.SQUARE_LOCATION_ID, '');
});

test('insertClientRecord: settings fill in user-definable keys and skip everything else', async () => {
  await insertClientRecord(dbConfig, DB_NAME, clientData({
    username: 'CLIENTWITHSETTINGS',
    settings: {
      OMDB_API_KEY: 'omdb-key',
      GOOGLE_SERVICE_ACCOUNT_KEY: { type: 'service_account', client_email: 'svc@example.com' },
      CINEMA_CALENDAR_ID: 'cinema@group.calendar.google.com',
      FTP1_HOST: 'ftp.example.com',
      JWT_SECRET: 'attacker-chosen',
      NOT_A_REAL_KEY: 'x'
    }
  }));
  const config = await configFor('CLIENTWITHSETTINGS');
  assert.equal(config.OMDB_API_KEY, 'omdb-key');
  assert.deepEqual(config.GOOGLE_SERVICE_ACCOUNT_KEY, { type: 'service_account', client_email: 'svc@example.com' });
  assert.equal(config.CINEMA_CALENDAR_ID, 'cinema@group.calendar.google.com');
  assert.equal(config.FTP1_HOST, 'ftp.example.com');
  assert.notEqual(config.JWT_SECRET, 'attacker-chosen');
  assert.equal(config.NOT_A_REAL_KEY, undefined);
});

test('insertClientRecord: explicit Square values win over the same keys in settings', async () => {
  await insertClientRecord(dbConfig, DB_NAME, clientData({
    username: 'CLIENTSQUAREWINS',
    square_webhook_url: 'https://explicit.example.com/webhook/square',
    settings: { SQUARE_SIGNATURE_KEY: 'from-settings', SQUARE_WEBHOOK_URL: 'https://settings.example.com', SQUARE_LOCATION_ID: 'LOCFROMSETTINGS' }
  }));
  const config = await configFor('CLIENTSQUAREWINS');
  assert.equal(config.SQUARE_SIGNATURE_KEY, 'square-sig-key');
  assert.equal(config.SQUARE_WEBHOOK_URL, 'https://explicit.example.com/webhook/square');
  // No explicit location was passed, so the settings file's value is used.
  assert.equal(config.SQUARE_LOCATION_ID, 'LOCFROMSETTINGS');
});
