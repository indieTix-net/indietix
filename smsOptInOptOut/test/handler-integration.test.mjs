import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { PinpointSMSVoiceV2Client, DeleteOptedOutNumberCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';

// Full end-to-end exercise of handler() against a real database: only
// Secrets Manager (pointed at our real test container) and the Pinpoint
// SMS Voice client are mocked -- discoverClientIds, findClientByDestination
// Number, findConsentInClient, handleStop/handleStart all run for real.
//
// CLIENT_IDS override has to be set before importing src/index.mjs (it's
// captured at module load time), so this needs its own test file.
const CLIENT_ID = 'M5E5N7KAHZA7Q';
process.env.CLIENT_IDS = CLIENT_ID;

const { handler } = await import('../src/index.mjs');

const { Client } = pg;

const ORIGINATION_NUMBER = '+19135550000'; // the client's own number (destination of inbound SMS)

const secretsMock = mockClient(SecretsManagerClient);
const smsVoiceMock = mockClient(PinpointSMSVoiceV2Client);

let dbConfig, containerName, client;

before(async () => {
  // createClientPool() hardcodes `database: clientId` (production's real
  // convention -- every client's database is named after their clientId),
  // so the test database has to actually be named CLIENT_ID for the real
  // findClientByDestinationNumber -> createClientPool path to connect to
  // the right place, rather than mocking that connection step away too.
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: CLIENT_ID }));
  await createDatabaseObjects(dbConfig, CLIENT_ID, 1, 'Test Theatre', 'TT');
  client = new Client(dbConfig);
  await client.connect();

  await client.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ($1, 'secret', 'Test Contact', 'test@example.com', $2)`,
    [CLIENT_ID, JSON.stringify({ SMS_ORIGINATION_NUMBER: ORIGINATION_NUMBER, SMS_OPT_OUT_LIST_NAME: 'test-optout-list' })]
  );

  // getDatabaseCredentials' Secrets Manager response needs to point at the
  // REAL running test container -- this is the one seam that's mocked;
  // everything downstream of it is a real database connection.
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.user,
      password: dbConfig.password,
      ssl: 'false'
    })
  });
});

beforeEach(() => {
  secretsMock.resetHistory();
  smsVoiceMock.reset();
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

function snsEvent(payload) {
  return { Records: [{ Sns: { Message: JSON.stringify(payload) } }] };
}

test('handler: a STOP SMS revokes the customer\'s active consent in the real database', async () => {
  const phone = nextPhone();
  await client.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText")
     VALUES (1, $1, 'active', 'web_initial', 'consent text')`,
    [phone]
  );

  const result = await handler(snsEvent({
    originationNumber: phone,
    destinationNumber: ORIGINATION_NUMBER,
    messageKeyword: 'STOP',
    messageBody: 'STOP'
  }));

  assert.equal(result.statusCode, 200);

  const row = await client.query(`SELECT "Status" FROM "SmsConsent" WHERE "PhoneNumber" = $1`, [phone]);
  assert.equal(row.rows[0].Status, 'revoked');
});

test('handler: a START SMS resubscribes and removes the number from the AWS opt-out list', async () => {
  smsVoiceMock.reset();
  smsVoiceMock.on(DeleteOptedOutNumberCommand).resolves({});

  const phone = nextPhone();
  await client.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText", "RevokedAt")
     VALUES (1, $1, 'revoked', 'web_initial', 'consent text', CURRENT_TIMESTAMP)`,
    [phone]
  );

  const result = await handler(snsEvent({
    originationNumber: phone,
    destinationNumber: ORIGINATION_NUMBER,
    messageKeyword: 'START',
    messageBody: 'START'
  }));

  assert.equal(result.statusCode, 200);

  const row = await client.query(
    `SELECT "Status" FROM "SmsConsent" WHERE "PhoneNumber" = $1 ORDER BY "ConsentTimestamp" DESC LIMIT 1`,
    [phone]
  );
  assert.equal(row.rows[0].Status, 'active');

  const optOutCall = smsVoiceMock.commandCalls(DeleteOptedOutNumberCommand)[0];
  assert.equal(optOutCall.args[0].input.OptOutListName, 'test-optout-list');
});

test('handler: a message to a destination number nobody owns is a safe no-op', async () => {
  const result = await handler(snsEvent({
    originationNumber: nextPhone(),
    destinationNumber: '+19999999999', // not this client's number
    messageKeyword: 'STOP',
    messageBody: 'STOP'
  }));
  assert.equal(result.statusCode, 200);
});

test('handler: HELP does not touch consent state at all', async () => {
  const phone = nextPhone();
  await client.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText")
     VALUES (1, $1, 'active', 'web_initial', 'consent text')`,
    [phone]
  );

  await handler(snsEvent({
    originationNumber: phone,
    destinationNumber: ORIGINATION_NUMBER,
    messageKeyword: 'HELP',
    messageBody: 'HELP'
  }));

  const row = await client.query(`SELECT "Status" FROM "SmsConsent" WHERE "PhoneNumber" = $1`, [phone]);
  assert.equal(row.rows[0].Status, 'active', 'HELP must never change consent state');
});

test('handler: an unrecognized keyword is ignored entirely, no DB touched', async () => {
  const phone = nextPhone();
  const result = await handler(snsEvent({
    originationNumber: phone,
    destinationNumber: ORIGINATION_NUMBER,
    messageKeyword: '',
    messageBody: 'Thanks for the tickets, see you there!'
  }));
  assert.equal(result.statusCode, 200);
  // No SmsConsent row should have been created for a phone that never
  // opted in and whose message wasn't a recognized keyword.
  const row = await client.query(`SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = $1`, [phone]);
  assert.equal(row.rows.length, 0);
});

test('handler: STOP from a phone with no consent history is a safe no-op (AWS still handles the reply)', async () => {
  const phone = nextPhone();
  const result = await handler(snsEvent({
    originationNumber: phone,
    destinationNumber: ORIGINATION_NUMBER,
    messageKeyword: 'STOP',
    messageBody: 'STOP'
  }));
  assert.equal(result.statusCode, 200);
});
