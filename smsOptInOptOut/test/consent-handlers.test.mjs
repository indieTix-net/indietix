import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { handleStop, handleStart, findConsentInClient } from '../src/index.mjs';

const { Client } = pg;

let dbConfig, containerName, client;

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'sms_opt_in_opt_out_test' }));
  await createDatabaseObjects(dbConfig, 'sms_opt_in_opt_out_test', 1, 'Test Theatre', 'TT');
  client = new Client(dbConfig);
  await client.connect();
});

after(async () => {
  await client.end();
  await teardownTestDatabase(containerName);
});

let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  return `+1913555${String(1000 + phoneCounter).slice(-4)}`;
}

async function insertActiveConsent(phone, overrides = {}) {
  const defaults = { customerId: 1, optInMethod: 'web_initial', consentText: 'I agree to receive texts' };
  const row = { ...defaults, ...overrides };
  const result = await client.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText")
     VALUES ($1, $2, 'active', $3, $4) RETURNING *`,
    [row.customerId, phone, row.optInMethod, row.consentText]
  );
  return result.rows[0];
}

async function insertRevokedConsent(phone, overrides = {}) {
  const defaults = { customerId: 1, optInMethod: 'web_initial', consentText: 'I agree to receive texts' };
  const row = { ...defaults, ...overrides };
  const result = await client.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText", "RevokedAt")
     VALUES ($1, $2, 'revoked', $3, $4, CURRENT_TIMESTAMP) RETURNING *`,
    [row.customerId, phone, row.optInMethod, row.consentText]
  );
  return result.rows[0];
}

test('findConsentInClient: returns the single consent row for a phone', async () => {
  const phone = nextPhone();
  const inserted = await insertActiveConsent(phone);
  // findConsentInClient only SELECTs ID/Status/RevokedAt/ConsentTimestamp/
  // CustomerID (not PhoneNumber or PreviousConsentID) -- matching its real
  // column list rather than asserting on fields it never returns.
  const found = await findConsentInClient(client, phone);
  assert.equal(found.ID, inserted.ID);
  assert.equal(found.Status, 'active');
});

test('findConsentInClient: returns the MOST RECENT row when a phone has history (revoked then active)', async () => {
  const phone = nextPhone();
  const revoked = await insertRevokedConsent(phone);
  // Ensure a strictly later ConsentTimestamp than the revoked row.
  const resub = await client.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText", "PreviousConsentID", "ConsentTimestamp")
     VALUES (1, $1, 'active', 'sms_start', 'resub', $2, CURRENT_TIMESTAMP + INTERVAL '1 second') RETURNING "ID"`,
    [phone, revoked.ID]
  );
  const found = await findConsentInClient(client, phone);
  assert.equal(found.Status, 'active');
  assert.equal(found.ID, resub.rows[0].ID, 'should return the newer row, not the revoked one');
});

test('findConsentInClient: returns null for a phone with no history at all', async () => {
  const found = await findConsentInClient(client, nextPhone());
  assert.equal(found, null);
});

test('handleStop: revokes the active consent row and sets RevokedAt', async () => {
  const phone = nextPhone();
  const active = await insertActiveConsent(phone);

  const result = await handleStop({ pool: client, normalizedPhone: phone, mostRecentConsent: active });
  assert.equal(result.revoked, 1);

  const row = await client.query(`SELECT * FROM "SmsConsent" WHERE "ID" = $1`, [active.ID]);
  assert.equal(row.rows[0].Status, 'revoked');
  assert.ok(row.rows[0].RevokedAt, 'RevokedAt should be set');
});

test('handleStop: is a no-op when the most recent consent is already revoked (idempotent)', async () => {
  const phone = nextPhone();
  const revoked = await insertRevokedConsent(phone);

  const result = await handleStop({ pool: client, normalizedPhone: phone, mostRecentConsent: revoked });
  assert.equal(result.revoked, 0);
});

test('handleStart: inserts a new active row linked to the previous one via PreviousConsentID', async () => {
  const phone = nextPhone();
  const revoked = await insertRevokedConsent(phone, { customerId: 42 });

  await handleStart({
    pool: client,
    normalizedPhone: phone,
    mostRecentConsent: revoked,
    clientConfig: { SMS_CAMPAIGN_ID: 'CAMPAIGN-1' }
  });

  const found = await findConsentInClient(client, phone);
  assert.equal(found.Status, 'active');
  assert.equal(found.CustomerID, 42, 'carries the same CustomerID forward');

  const full = await client.query(`SELECT * FROM "SmsConsent" WHERE "ID" = $1`, [found.ID]);
  assert.equal(full.rows[0].PreviousConsentID, revoked.ID);
  assert.equal(full.rows[0].CampaignID, 'CAMPAIGN-1');
  assert.equal(full.rows[0].OptInMethod, 'sms_start');
});

test('handleStart: does NOT insert a second active row when already active (idempotent, respects the one-active-per-phone constraint)', async () => {
  const phone = nextPhone();
  const active = await insertActiveConsent(phone);

  await handleStart({
    pool: client,
    normalizedPhone: phone,
    mostRecentConsent: active,
    clientConfig: {}
  });

  const result = await client.query(`SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = $1`, [phone]);
  assert.equal(result.rows.length, 1, 'no new row should have been inserted');
});

test('handleStop then handleStart: a full revoke-and-resubscribe cycle ends with exactly one active row', async () => {
  const phone = nextPhone();
  const original = await insertActiveConsent(phone);

  await handleStop({ pool: client, normalizedPhone: phone, mostRecentConsent: original });
  const afterStop = await findConsentInClient(client, phone);
  assert.equal(afterStop.Status, 'revoked');

  await handleStart({ pool: client, normalizedPhone: phone, mostRecentConsent: afterStop, clientConfig: {} });

  const all = await client.query(`SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = $1 ORDER BY "ID"`, [phone]);
  assert.equal(all.rows.length, 2, 'original row + one new resubscribe row');
  const activeRows = all.rows.filter(r => r.Status === 'active');
  assert.equal(activeRows.length, 1, 'exactly one active row -- the unique partial index would reject more');
  assert.equal(activeRows[0].PreviousConsentID, original.ID);
});
