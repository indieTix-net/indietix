// Shared test harness for getSquareOrders' SQS-triggered handler. No HTTP
// server here (unlike QRScanner) -- this is a plain Lambda handler, so
// tests call handler({ Records: [...] }) directly. Same DB-credentials
// and dual-package-hazard lessons as QRScanner's harness apply: a real
// per-client Postgres container via test-db-harness, Secrets Manager
// mocked per-clientId, and sms-utils' own separate @aws-sdk/client-
// pinpoint-sms-voice-v2 copy mocked via its own package.json-anchored
// require() so a test never fires a real AWS SMS call.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../../clientSetup-Teardown/src/index.js';

const { Client } = pg;

// index.mjs's getClientPoolWithSecrets() creates a new pg.Pool per
// invocation and, by deliberate design (see this repo's README --
// pools are meant to outlive one invocation across warm Lambda
// containers), never calls .end() on it except in specific error paths.
// In a real Lambda that's fine; in a test process it means every pool
// from every processWebhook() call stays open past the test that created
// it, and when stopTestEnv() tears down that test's Docker Postgres
// container, the still-open pool's connection gets forcibly severed --
// surfacing as an uncaught "terminating connection due to administrator
// command" well after the test finished. Patching pg.Pool here (BEFORE
// index.mjs is imported, so its own `const { Pool } = pg` destructure
// picks up this tracked version -- import order in test files matters:
// this harness must be imported before '../src/index.mjs') lets
// stopTestEnv() close every pool that was actually created during the
// test, without changing index.mjs's own intentional behavior at all.
const trackedPools = new Set();
const OriginalPool = pg.Pool;
pg.Pool = class TrackedPool extends OriginalPool {
  constructor(config) {
    super(config);
    trackedPools.add(this);
  }
};

export async function closeAllTrackedPools() {
  const pools = Array.from(trackedPools);
  trackedPools.clear();
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
}

process.env.TICKET_SIGNER_ACCESS_KEY ||= 'test-ticket-signer-access-key';
process.env.TICKET_SIGNER_SECRET_KEY ||= 'test-ticket-signer-secret-key';
process.env.AWS_REGION ||= 'us-east-2';

// See QRScanner/test/helpers/testServer.mjs for the full explanation of
// why this can't be a plain top-level `import` -- sms-utils is an
// external sibling package with its OWN separate node_modules copy of
// this AWS SDK client, a different object than whatever this repo's own
// node_modules resolves, so mocking the wrong one silently fires a real
// AWS call. Anchoring require() at sms-utils' own package.json forces
// resolution through its node_modules, landing on the exact class
// instance sms-utils/src/sms.mjs holds a reference to.
const smsUtilsRequire = createRequire(new URL('../../../sms-utils/package.json', import.meta.url));
const { PinpointSMSVoiceV2Client, SendTextMessageCommand } = smsUtilsRequire('@aws-sdk/client-pinpoint-sms-voice-v2');

export const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';

// ---------------------------------------------------------------------
// Secrets Manager mock, keyed by clientId (see QRScanner harness for why
// a single "currently active" slot is the wrong design).
// ---------------------------------------------------------------------
export const secretsMock = mockClient(SecretsManagerClient);
const dbConfigsByClientId = new Map();
secretsMock.on(GetSecretValueCommand).callsFake((input) => {
  const match = /^indieTix\/rds\/clients\/([^/]+)\/credentials$/.exec(input.SecretId || '');
  const clientId = match ? match[1] : null;
  const dbConfig = clientId ? dbConfigsByClientId.get(clientId) : null;
  if (!dbConfig) throw new Error(`No active test database for client "${clientId}" -- call startTestEnv() first`);
  return {
    SecretString: JSON.stringify({
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.user,
      password: dbConfig.password,
      ssl: 'false'
    })
  };
});

// ---------------------------------------------------------------------
// S3 mock (v3). GetObjectCommand must resolve a real readable stream --
// ticket-pdf-lib's fetchPdfFromS3 consumes response.Body as a stream, not
// a Buffer, matching the real S3Client's shape.
// ---------------------------------------------------------------------
export const s3Mock = mockClient(S3Client);
export const s3Handlers = {};

function bufferToSdkStream(buffer) {
  return Readable.from(buffer);
}

function defaultS3Handlers(templatePdfBuffer) {
  return {
    getObject: async () => ({ Body: bufferToSdkStream(templatePdfBuffer) }),
    putObject: async () => ({ ETag: '"mock-etag"' })
  };
}

export function resetS3Handlers(templatePdfBuffer) {
  Object.assign(s3Handlers, defaultS3Handlers(templatePdfBuffer));
}

s3Mock.on(GetObjectCommand).callsFake((input) => s3Handlers.getObject(input));
s3Mock.on(PutObjectCommand).callsFake((input) => s3Handlers.putObject(input));

// ---------------------------------------------------------------------
// SES mock (v3)
// ---------------------------------------------------------------------
export const sesMock = mockClient(SESClient);
export const sesHandlers = {};

function defaultSesHandlers() {
  return {
    sendRawEmail: async () => ({ MessageId: 'mock-ses-message-id' })
  };
}

export function resetSesHandlers() {
  Object.assign(sesHandlers, defaultSesHandlers());
}

sesMock.on(SendRawEmailCommand).callsFake((input) => sesHandlers.sendRawEmail(input));

// ---------------------------------------------------------------------
// Pinpoint SMS mock (v3, sms-utils' own copy -- see note above)
// ---------------------------------------------------------------------
export const pinpointMock = mockClient(PinpointSMSVoiceV2Client);
export const smsHandlers = {};

function defaultSmsHandlers() {
  return {
    sendTextMessage: async () => ({ MessageId: 'mock-sms-message-id' })
  };
}

export function resetSmsHandlers() {
  Object.assign(smsHandlers, defaultSmsHandlers());
}

pinpointMock.on(SendTextMessageCommand).callsFake((input) => smsHandlers.sendTextMessage(input));

// ---------------------------------------------------------------------
// Square REST API mock (plain fetch). Only intercepts connect.squareup.com;
// everything else passes through to the real fetch.
// ---------------------------------------------------------------------
export const squareHandlers = {};

function defaultSquareHandlers() {
  return {
    getOrder: async (orderId) => ({ ok: true, status: 200, json: async () => ({ order: { id: orderId, line_items: [] } }) }),
    batchRetrieveCatalog: async () => ({ ok: true, status: 200, json: async () => ({ objects: [], related_objects: [] }) }),
    getPayment: async (paymentId) => ({
      ok: true, status: 200,
      json: async () => ({ payment: { id: paymentId, status: 'COMPLETED', customer_id: null } })
    }),
    getCustomer: async (customerId) => ({
      ok: true, status: 200,
      json: async () => ({ customer: { id: customerId, email_address: 'square-customer@example.com', given_name: 'Square', family_name: 'Customer', phone_number: '+15551234567' } })
    }),
    getCatalogObject: async (objectId) => ({
      ok: true, status: 200,
      json: async () => ({ object: { id: objectId, custom_attribute_definition_data: { selection_config: { allowed_selections: [] } } } })
    })
  };
}

export function resetSquareHandlers() {
  Object.assign(squareHandlers, defaultSquareHandlers());
}
resetSquareHandlers();

let fetchPatched = false;
function patchFetch() {
  if (fetchPatched) return;
  fetchPatched = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.startsWith('https://connect.squareup.com/v2/orders/')) {
      return squareHandlers.getOrder(urlStr.split('/').pop());
    }
    if (urlStr === 'https://connect.squareup.com/v2/catalog/batch-retrieve' && opts.method === 'POST') {
      return squareHandlers.batchRetrieveCatalog(JSON.parse(opts.body));
    }
    if (urlStr.startsWith('https://connect.squareup.com/v2/payments/')) {
      return squareHandlers.getPayment(urlStr.split('/').pop());
    }
    if (urlStr.startsWith('https://connect.squareup.com/v2/customers/')) {
      return squareHandlers.getCustomer(urlStr.split('/').pop());
    }
    if (urlStr.startsWith('https://connect.squareup.com/v2/catalog/object/')) {
      return squareHandlers.getCatalogObject(urlStr.split('/').pop());
    }
    return realFetch(url, opts);
  };
}
patchFetch();

// ---------------------------------------------------------------------
// Square webhook signature helper -- mirrors square's own WebhooksHelper
// (HMAC-SHA256(notificationUrl + requestBody, signatureKey), base64),
// confirmed by reading node_modules/square/core/crypto/createHmacOverride.js.
// Lets prod-mode (ENV_TYPE: 'prod') tests build a REAL valid signature
// locally -- no network call, pure crypto, matching what processWebhook
// will independently recompute.
// ---------------------------------------------------------------------
export function computeSquareSignature(notificationUrl, requestBody, signatureKey) {
  return crypto.createHmac('sha256', signatureKey).update(notificationUrl + requestBody, 'utf8').digest('base64');
}

// ---------------------------------------------------------------------
// SQS event construction. handler() parses record.body as
// { headers, body: <stringified Square webhook payload> } --
// see index.mjs's handler: webhookMessage.body.headers ?? webhookMessage.headers,
// webhookMessage.body.body ?? webhookMessage.body. Using a plain (non-nested)
// shape here hits the right side of both `??`s.
// ---------------------------------------------------------------------
export function buildSqsEvent(records) {
  return { Records: records };
}

export function buildSqsRecord(squareWebhookPayload, headers = {}) {
  return {
    messageId: `msg-${crypto.randomBytes(8).toString('hex')}`,
    body: JSON.stringify({
      headers,
      body: JSON.stringify(squareWebhookPayload)
    })
  };
}

// ---------------------------------------------------------------------
// Test env lifecycle (DB only -- no HTTP server, unlike QRScanner)
// ---------------------------------------------------------------------
export async function startTestEnv(opts = {}) {
  resetSquareHandlers();
  resetSesHandlers();
  resetSmsHandlers();

  const clientId = opts.clientId || 'TESTCLIENT123';

  const { dbConfig, containerName } = await setupTestDatabase({ dbName: clientId });
  dbConfigsByClientId.set(clientId, dbConfig);
  await createDatabaseObjects(dbConfig, clientId, 1, 'Test Theatre', 'TT');

  const pgClient = new Client(dbConfig);
  await pgClient.connect();

  const configuration = {
    ENV_TYPE: 'dev',
    S3_BUCKET_PREFIX: 'indietix-',
    SENDER_EMAIL: 'noreply@example.com',
    SQUARE_ACCESS_TOKEN: 'test-square-access-token',
    USE_QR_CODE: 'UseQRCode',
    DISTRIBUTOR_NAME: 'Distributor',
    EVENT_TYPE: 'EventType',
    TICKET_FILENAME: 'ticket_horizontal.pdf',
    TICKET_ORIENTATION: 'horizontal',
    TICKET_SMS_FILENAME: 'ticket_vertical.pdf',
    TICKET_SMS_ORIENTATION: 'vertical',
    SEND_SMS: 'false',
    WEB_HEADER_COMPANY: 'Test Venue',
    ...opts.clientConfig
  };
  await pgClient.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ($1, 'unused-hash', 'Test Contact', 'contact@example.com', $2)`,
    [clientId, JSON.stringify(configuration)]
  );

  return { clientId, dbConfig, pgClient, containerName };
}

export async function stopTestEnv(ctx) {
  await closeAllTrackedPools();
  await ctx.pgClient.end();
  await teardownTestDatabase(ctx.containerName);
  dbConfigsByClientId.delete(ctx.clientId);
}
