// Shared test harness for QRScanner's Express app. Every route in app.mjs
// requires a real database connection (requireAuth itself connects to the
// client's own DB just to look up their JWT_SECRET, before it can even
// verify the token) -- so there's no meaningful way to test this app
// without a real, correctly-schema'd client database. AWS Secrets Manager
// is mocked to redirect every client-DB lookup at the real disposable
// container test-db-harness provides; AWS SDK v2 (SES, S3) has no
// per-client-mock story the way v3's aws-sdk-client-mock does, so its
// prototype methods are monkey-patched with overridable handlers instead.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import AWS from 'aws-sdk';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../../clientSetup-Teardown/src/index.js';
import { createRequire } from 'node:module';

// sms-utils is an external sibling package (symlinked into node_modules)
// with its OWN separate node_modules/@aws-sdk/client-pinpoint-sms-voice-v2
// install -- a different physical copy/version than QRScanner's own. A
// plain `import` of that package here would resolve QRScanner's copy, a
// DIFFERENT class object than the one sms-utils/src/sms.mjs actually calls
// .send() on, so aws-sdk-client-mock's prototype patch silently would not
// intercept anything -- confirmed the hard way: sendSms() made a real
// network call to AWS using this shell's live credentials before this fix
// (it only failed because the test's fake origination number doesn't exist
// in the real account; a valid one would have sent a real SMS). Anchoring
// `require` at sms-utils' own package.json forces resolution through
// sms-utils' node_modules, landing on the exact same CJS module instance
// (this package has no "type":"module"/"exports" map, so both sms.mjs's
// ESM import and this require() load the identical dist-cjs/index.js via
// Node's module cache) that sms.mjs holds a reference to.
const smsUtilsRequire = createRequire(new URL('../../../sms-utils/package.json', import.meta.url));
const { PinpointSMSVoiceV2Client, SendTextMessageCommand } = smsUtilsRequire('@aws-sdk/client-pinpoint-sms-voice-v2');

const { Client } = pg;

export const JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';

// presignTicketPdf (sms opt-in flow) signs with these directly via
// @aws-sdk/s3-request-presigner -- that's pure local SigV4 math, no network
// call, so any non-empty dummy value works here.
process.env.TICKET_SIGNER_ACCESS_KEY ||= 'test-ticket-signer-access-key';
process.env.TICKET_SIGNER_SECRET_KEY ||= 'test-ticket-signer-secret-key';
process.env.AWS_REGION ||= 'us-east-2';

// ---------------------------------------------------------------------
// sms-utils' sendSms() mock (AWS SDK v3, Pinpoint SMS Voice v2). Override
// smsHandlers.sendTextMessage per-test to simulate AWS failures.
// ---------------------------------------------------------------------
export const smsHandlers = {};

function defaultSmsHandlers() {
  return {
    sendTextMessage: async () => ({ MessageId: 'mock-sms-message-id' })
  };
}

export function resetSmsHandlers() {
  Object.assign(smsHandlers, defaultSmsHandlers());
}
resetSmsHandlers();

export const pinpointMock = mockClient(PinpointSMSVoiceV2Client);
pinpointMock.on(SendTextMessageCommand).callsFake((input) => smsHandlers.sendTextMessage(input));

// ---------------------------------------------------------------------
// AWS SDK v2 mocking (SES, S3). Each handler can be overridden per-test
// via s3Handlers.X = async (...) => {...}; reset to the harmless default
// in resetV2Handlers() between tests.
// ---------------------------------------------------------------------
export const s3Handlers = {};
export const sesHandlers = {};

function defaultS3Handlers() {
  return {
    getObject: async () => ({ Body: Buffer.from('mock-s3-object-body') }),
    putObject: async () => ({ ETag: '"mock-etag"' }),
    getSignedUrlPromise: async (operation, params) => `https://mock-bucket.s3.amazonaws.com/${params?.Key || 'mock-key'}?X-Mock-Signed=1`,
    listObjectsV2: async () => ({ Contents: [] }),
    deleteObject: async () => ({}),
    deleteObjects: async () => ({ Deleted: [] }),
    copyObject: async () => ({}),
    headObject: async () => ({ ContentLength: 0 })
  };
}

function defaultSesHandlers() {
  return {
    sendRawEmail: async () => ({ MessageId: 'mock-ses-message-id' })
  };
}

export function resetV2Handlers() {
  Object.assign(s3Handlers, defaultS3Handlers());
  Object.assign(sesHandlers, defaultSesHandlers());
}
resetV2Handlers();

// ---------------------------------------------------------------------
// Square REST API mock (plain fetch, not an AWS SDK) -- only intercepts
// connect.squareup.com; every other URL passes through to the real fetch
// so this harness never has to know about every outbound call app.mjs
// might make.
// ---------------------------------------------------------------------
export const squareHandlers = {};

function defaultSquareHandlers() {
  return {
    getPayment: async (paymentId) => ({
      ok: true,
      status: 200,
      json: async () => ({
        payment: {
          id: paymentId,
          status: 'COMPLETED',
          amount_money: { amount: 1000, currency: 'USD' },
          refund_ids: []
        }
      })
    }),
    createRefund: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ refund: { id: 'mock-refund-id', status: 'PENDING' } })
    }),
    searchCatalog: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ objects: [] })
    }),
    // GET /v2/catalog/list?types=CATEGORY|CUSTOM_ATTRIBUTE_DEFINITION, used
    // by create-movie-item/create-event-item. Includes a "Cinema" category
    // by default; a missing one gets created through createCatalogObject.
    listCatalogCategories: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ objects: [{ id: 'MOCK_CAT_CINEMA', category_data: { name: 'Cinema' } }] })
    }),
    listCatalogCustomAttributes: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ objects: [] })
    }),
    // POST /v2/catalog/object -- called once to create the showtimes
    // MODIFIER_LIST, once to create the ITEM itself. Echoes back whatever
    // was sent with a mock id, assigning mock ids to each variation too
    // (create-movie-item needs real-looking variation ids for the
    // inventory batch-create call that follows).
    createCatalogObject: async (body) => {
      const obj = body.object;
      if (obj.type === 'ITEM' && obj.item_data) {
        const variations = (obj.item_data.variations || []).map((v, i) => ({ ...v, id: `MOCK_VAR_${i}` }));
        return {
          ok: true, status: 200,
          json: async () => ({ catalog_object: { ...obj, id: 'MOCK_ITEM_ID', item_data: { ...obj.item_data, variations } } })
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ catalog_object: { ...obj, id: 'MOCK_MODIFIER_LIST_ID' } })
      };
    },
    batchCreateInventory: async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
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
    if (urlStr.startsWith('https://connect.squareup.com/v2/payments/') && (!opts.method || opts.method === 'GET')) {
      const paymentId = urlStr.split('/').pop();
      return squareHandlers.getPayment(paymentId);
    }
    if (urlStr === 'https://connect.squareup.com/v2/refunds' && opts.method === 'POST') {
      return squareHandlers.createRefund(JSON.parse(opts.body));
    }
    if (urlStr === 'https://connect.squareup.com/v2/catalog/search' && opts.method === 'POST') {
      return squareHandlers.searchCatalog(JSON.parse(opts.body));
    }
    if (urlStr.startsWith('https://connect.squareup.com/v2/catalog/list')) {
      const types = new URL(urlStr).searchParams.get('types');
      if (types === 'CATEGORY') return squareHandlers.listCatalogCategories();
      if (types === 'CUSTOM_ATTRIBUTE_DEFINITION') return squareHandlers.listCatalogCustomAttributes();
      return { ok: true, status: 200, json: async () => ({ objects: [] }) };
    }
    if (urlStr === 'https://connect.squareup.com/v2/catalog/object' && opts.method === 'POST') {
      return squareHandlers.createCatalogObject(JSON.parse(opts.body));
    }
    if (urlStr === 'https://connect.squareup.com/v2/inventory/changes/batch-create' && opts.method === 'POST') {
      return squareHandlers.batchCreateInventory(JSON.parse(opts.body));
    }
    // OMDB (movie lookup) -- records every URL so tests can check the key
    // never leaves the server, and lets a test choose the answer.
    if (urlStr.startsWith('https://www.omdbapi.com/') || urlStr.startsWith('https://img.omdbapi.com/')) {
      omdbCalls.push(urlStr);
      return omdbHandler(new URL(urlStr));
    }
    return realFetch(url, opts);
  };
}

// ---- OMDB fake ----
export const omdbCalls = [];
let omdbHandler;
export function setOmdbHandler(handler) { omdbHandler = handler; }
export function resetOmdb() {
  omdbCalls.length = 0;
  omdbHandler = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ Response: 'False', Error: 'Movie not found!' }) });
}
resetOmdb();

let v2Patched = false;
function patchAwsV2() {
  if (v2Patched) return;
  v2Patched = true;

  for (const method of Object.keys(defaultS3Handlers())) {
    AWS.S3.prototype[method] = function (...args) {
      const result = s3Handlers[method](...args);
      return { promise: () => Promise.resolve(result).then(r => r) };
    };
  }
  // getSignedUrlPromise is itself already a promise-returning method (no
  // .promise() wrapper) on the real SDK -- match that shape exactly.
  AWS.S3.prototype.getSignedUrlPromise = function (operation, params) {
    return Promise.resolve(s3Handlers.getSignedUrlPromise(operation, params));
  };

  AWS.SES.prototype.sendRawEmail = function (...args) {
    const result = sesHandlers.sendRawEmail(...args);
    return { promise: () => Promise.resolve(result).then(r => r) };
  };
}

// ---------------------------------------------------------------------
// Secrets Manager mock (v3) -- keyed by clientId (parsed out of the
// `indieTix/rds/clients/{clientId}/credentials` SecretId, matching
// getDatabaseCredentials' own naming convention) rather than a single
// "currently active" slot. A single shared slot broke the moment a test
// started a second server mid-file (e.g. to exercise an unconfigured
// client): stopping that second server nulled the slot out from under
// the first server's still-running tests, which then failed with
// "No active test database" for the rest of the file.
// ---------------------------------------------------------------------
export const secretsMock = mockClient(SecretsManagerClient);

const dbConfigsByClientId = new Map();
secretsMock.on(GetSecretValueCommand).callsFake((input) => {
  const match = /^indieTix\/rds\/clients\/([^/]+)\/credentials$/.exec(input.SecretId || '');
  const clientId = match ? match[1] : null;
  const dbConfig = clientId ? dbConfigsByClientId.get(clientId) : null;
  if (!dbConfig) throw new Error(`No active test database for client "${clientId}" -- call startTestServer() first`);
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
// Server lifecycle
// ---------------------------------------------------------------------

/**
 * @param {Object} [opts]
 * @param {string} [opts.clientId='TESTCLIENT123'] - must look like a real
 *   clientID (createClientDbConnection validates /^[A-Za-z0-9]+$/), and is
 *   used as both the JWT "username"/"dbName" field and the real Postgres
 *   database name (createClientDbConnection hardcodes database: clientId).
 * @param {Object} [opts.clientConfig] - merged into Client.configuration.
 * @param {string} [opts.clientPassword='client-password'] - plaintext;
 *   bcrypt-hashed into clientSecret for client-login tests.
 * @returns {Promise<{app, baseUrl, server, dbConfig, pgClient, clientId,
 *   clientToken, signToken, request, insertUser}>}
 */
export async function startTestServer(opts = {}) {
  patchAwsV2();
  resetV2Handlers();
  patchFetch();
  resetSquareHandlers();
  resetSmsHandlers();
  pinpointMock.reset();
  pinpointMock.on(SendTextMessageCommand).callsFake((input) => smsHandlers.sendTextMessage(input));

  const clientId = opts.clientId || 'TESTCLIENT123';
  const clientPassword = opts.clientPassword || 'client-password';

  const { dbConfig, containerName } = await setupTestDatabase({ dbName: clientId });
  dbConfigsByClientId.set(clientId, dbConfig);
  await createDatabaseObjects(dbConfig, clientId, 1, 'Test Theatre', 'TT');

  const pgClient = new Client(dbConfig);
  await pgClient.connect();

  const hashedClientSecret = await bcrypt.hash(clientPassword, 10);
  const configuration = {
    JWT_SECRET,
    SENDER_EMAIL: 'noreply@example.com',
    STATIC_WEBSITE_URL: 'https://example.com',
    S3_BUCKET_PREFIX: 'indietix-',
    WEB_HEADER_COMPANY: 'Test Venue',
    PASSWORD_RESET_SECRET: 'test-password-reset-secret-32-bytes!!',
    SQUARE_ACCESS_TOKEN: 'test-square-access-token',
    ...opts.clientConfig
  };
  await pgClient.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "configuration")
     VALUES ($1, $2, 'Test Contact', 'contact@example.com', $3)`,
    [clientId, hashedClientSecret, JSON.stringify(configuration)]
  );

  // Dynamic import AFTER Secrets Manager is mocked and the DB exists --
  // app.mjs reads globalConfig.ENV_TYPE at module scope on first import,
  // and every route needs the mock already armed.
  const { default: app } = await import('../../src/app.mjs');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  function signToken(payload, { expiresIn = '24h' } = {}) {
    return jwt.sign({ username: clientId, dbName: clientId, ...payload }, JWT_SECRET, { expiresIn });
  }

  const clientToken = signToken({ userType: 'client' });

  async function request(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Inserts a sub-user row (bcrypt-hashed password) and returns {id, token}. */
  async function insertUser({ username, password = 'user-password', email, firstName = 'Test', lastName = 'User', permissions, dataFilter }) {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pgClient.query(
      `INSERT INTO "Users" ("Username", "Password", "Email", "FirstName", "LastName", "Permissions", "DataFilter")
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "ID"`,
      [username, hashed, email || `${username}@example.com`, firstName, lastName,
        JSON.stringify(permissions || { view: true, edit: true, checkIn: true, marketing: false, admin: false }),
        JSON.stringify(dataFilter || { datafilters: [] })]
    );
    const userId = result.rows[0].ID;
    const token = signToken({ userType: 'user', userId, permissions: permissions || { view: true, edit: true, checkIn: true, marketing: false, admin: false }, dataFilter: dataFilter || { datafilters: [] } });
    return { id: userId, token };
  }

  return { app, baseUrl, server, dbConfig, pgClient, clientId, clientToken, signToken, request, insertUser, containerName };
}

export async function stopTestServer(ctx) {
  await new Promise((resolve) => ctx.server.close(resolve));
  await ctx.pgClient.end();
  await teardownTestDatabase(ctx.containerName);
  dbConfigsByClientId.delete(ctx.clientId);
}
