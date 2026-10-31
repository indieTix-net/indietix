import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { refreshTikTokToken, __setCurrentClientConfigForTesting } from '../src/index.mjs';

// TikTok's refresh token ROTATES on every redemption -- the one just used
// is dead the instant the call succeeds, so the new access+refresh pair
// MUST be persisted to the database immediately, or the next refresh
// attempt is permanently bricked. This is
// the single most dangerous piece of behavior in this file -- tested
// against a real database, not mocked, so a persistence bug would
// actually show up.

let originalFetch;
let dbConfig, containerName, client;

before(async () => {
  originalFetch = globalThis.fetch;

  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'tiktok_refresh_test' }));
  await createDatabaseObjects(dbConfig, 'tiktok_refresh_test', 1, 'Test Theatre', 'TT');
  client = new pg.Client(dbConfig);
  await client.connect();
  await client.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ('tiktok_refresh_test', 'secret', 'Contact', 'contact@example.com', $1)`,
    [JSON.stringify({ TIKTOK_CLIENT_KEY: 'key-1', TIKTOK_CLIENT_SECRET: 'secret-1', TIKTOK_REFRESH_TOKEN: 'old-refresh-token', TIKTOK_ACCESS_TOKEN: 'old-access-token' })]
  );
});

after(async () => {
  globalThis.fetch = originalFetch;
  await client.end();
  await teardownTestDatabase(containerName);
});

beforeEach(() => {
  __setCurrentClientConfigForTesting({
    TIKTOK_CLIENT_KEY: 'key-1', TIKTOK_CLIENT_SECRET: 'secret-1',
    TIKTOK_REFRESH_TOKEN: 'old-refresh-token', TIKTOK_ACCESS_TOKEN: 'old-access-token'
  });
});

test('refreshTikTokToken: on success, persists the NEW rotated access+refresh pair to the database immediately', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://open.tiktokapis.com/v2/oauth/token/');
    return { ok: true, json: async () => ({ access_token: 'new-access-token', refresh_token: 'new-refresh-token' }) };
  };

  await refreshTikTokToken(client, 'tiktok_refresh_test');

  const row = await client.query(`SELECT "configuration" FROM "Client" WHERE "clientID" = 'tiktok_refresh_test'`);
  assert.equal(row.rows[0].configuration.TIKTOK_ACCESS_TOKEN, 'new-access-token');
  assert.equal(row.rows[0].configuration.TIKTOK_REFRESH_TOKEN, 'new-refresh-token', 'the OLD refresh token must be gone from the DB -- it is dead the instant the exchange succeeds');
});

test('refreshTikTokToken: also updates the in-memory currentClientConfig object the rest of the send flow reads', async () => {
  // sendTikTokPost reads currentClientConfig.TIKTOK_ACCESS_TOKEN directly
  // -- if this weren't updated in memory too (only in the DB), the send
  // immediately following a refresh would still use the now-dead old
  // token. currentClientConfig.TIKTOK_ACCESS_TOKEN = ... mutates the
  // object by reference, so holding onto the same reference we set lets
  // the test observe that mutation directly.
  const configRef = {
    TIKTOK_CLIENT_KEY: 'key-1', TIKTOK_CLIENT_SECRET: 'secret-1',
    TIKTOK_REFRESH_TOKEN: 'old-refresh-token', TIKTOK_ACCESS_TOKEN: 'old-access-token'
  };
  __setCurrentClientConfigForTesting(configRef);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'memory-access-token', refresh_token: 'memory-refresh-token' }) });

  await refreshTikTokToken(client, 'tiktok_refresh_test');

  assert.equal(configRef.TIKTOK_ACCESS_TOKEN, 'memory-access-token');
  assert.equal(configRef.TIKTOK_REFRESH_TOKEN, 'memory-refresh-token');
});

test('refreshTikTokToken: a failed exchange (e.g. expired/already-redeemed refresh token) throws and does NOT touch the database', async () => {
  const before = await client.query(`SELECT "configuration" FROM "Client" WHERE "clientID" = 'tiktok_refresh_test'`);

  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'invalid_grant' } }) });

  await assert.rejects(() => refreshTikTokToken(client, 'tiktok_refresh_test'), /TikTok token refresh failed/);

  const after = await client.query(`SELECT "configuration" FROM "Client" WHERE "clientID" = 'tiktok_refresh_test'`);
  assert.deepEqual(after.rows[0].configuration, before.rows[0].configuration, 'a failed refresh must not overwrite the still-potentially-valid stored tokens');
});

test('refreshTikTokToken: TikTok returning HTTP 200 with an error payload is still treated as a failure (documented quirk)', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { code: 'invalid_grant', message: 'refresh token expired' } }) });
  await assert.rejects(() => refreshTikTokToken(client, 'tiktok_refresh_test'), /TikTok token refresh failed/);
});

test('refreshTikTokToken: is a no-op (no fetch call, no DB write) when any of the three OAuth config keys is missing', async () => {
  __setCurrentClientConfigForTesting({ TIKTOK_ACCESS_TOKEN: 'static-token-only' }); // no CLIENT_KEY/SECRET/REFRESH_TOKEN

  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

  await refreshTikTokToken(client, 'tiktok_refresh_test');
  assert.equal(fetchCalled, false, 'a client with only a static TIKTOK_ACCESS_TOKEN must keep working unchanged, never attempt a refresh');
});
