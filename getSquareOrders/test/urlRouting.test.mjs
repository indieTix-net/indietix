import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
// Must be imported BEFORE '../src/index.mjs' (see processWebhook.test.mjs).
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  resetS3Handlers, resetSesHandlers, resetSmsHandlers,
  buildSqsEvent, buildSqsRecord, buildWrappedSqsRecord, computeSquareSignature
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

// ---- Venue ID carried in the webhook URL (?client=) ----
// A venue whose IndieTix client ID is NOT its Square merchant ID (like the
// production `indietix` test venue). Its own Square webhook subscription
// URL carries ?client=<its ID>; Square signs that full URL (proven against
// the Square sandbox 2026-11-19), so the ID can't be swapped.

const VENUE = 'urlvenue1';
const MERCHANT = 'MERCHURL1';
const SIG_KEY = 'url-venue-sig-key';
const BASE_URL = 'https://example.com/webhook/square';
const urlFor = (client) => `${BASE_URL}?client=${client}`;

let ctx;

async function blankTemplate(width = 1800, height = 600) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

const BASE_CONFIG = {
  ENV_TYPE: 'prod',
  SQUARE_SIGNATURE_KEY: SIG_KEY,
  SQUARE_WEBHOOK_URL: urlFor(VENUE),
  SQUARE_MERCHANT_ID: MERCHANT
};

async function setConfig(overrides) {
  const config = { ...BASE_CONFIG, ...overrides };
  for (const [key, value] of Object.entries(config)) if (value === undefined) delete config[key];
  await ctx.pgClient.query(
    `UPDATE "Client" SET "configuration" = ("configuration"::jsonb - 'SQUARE_MERCHANT_ID') || $1::jsonb WHERE "clientID" = $2`,
    [JSON.stringify(config), VENUE]
  );
}

before(async () => {
  ctx = await startTestEnv({ clientId: VENUE, clientConfig: BASE_CONFIG });
});
after(async () => { await stopTestEnv(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  resetSesHandlers();
  resetSmsHandlers();
  resetS3Handlers(await blankTemplate());
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
  await ctx.pgClient.query(`DELETE FROM "NoTicketOrder"`);
  await setConfig({});
  installTicketOrder();
});

function installTicketOrder() {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId,
        location_id: 'LOC-1',
        line_items: [{
          uid: 'LI-1', catalog_object_id: 'VAR-1', name: 'Test Movie', quantity: '1',
          variation_name: 'Adult', base_price_money: { amount: 1250 },
          modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }]
        }]
      }
    })
  });
  squareHandlers.batchRetrieveCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [],
      related_objects: [{
        type: 'ITEM', id: 'ITEM-1',
        item_data: { name: 'Test Movie', categories: [], variations: [{ id: 'VAR-1' }] },
        custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } }
      }]
    })
  });
}

function payload({ merchant = MERCHANT, orderId = 'ORDER-URL-1' } = {}) {
  return {
    merchant_id: merchant,
    type: 'payment.updated',
    data: { object: { payment: { id: `PAY-${orderId}`, status: 'COMPLETED', order_id: orderId, buyer_email_address: 'buyer@example.com' } } }
  };
}

// A record as Square would deliver it to `signedUrl`, arriving with
// ?client=<client> on the request.
function record({ client = VENUE, signedUrl = urlFor(VENUE), body = payload(), wrapped = false } = {}) {
  const signature = computeSquareSignature(signedUrl, JSON.stringify(body), SIG_KEY);
  const build = wrapped ? buildWrappedSqsRecord : buildSqsRecord;
  return build(body, { 'x-square-hmacsha256-signature': signature }, { queryStringParameters: { client } });
}

async function orderCount() {
  return (await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "Order"`)).rows[0].n;
}

function captureRejections(t) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.map(String).join(' ')); });
  return () => lines.filter((l) => l.includes('SQUARE_WEBHOOK_REJECTED'));
}

test('?client=: a venue whose ID differs from its merchant ID gets its ticket', async () => {
  const result = await handler(buildSqsEvent([record()]));
  assert.equal(JSON.parse(result.body).results.success, 1);
  const tickets = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(tickets.rows.length, 1);
  assert.equal(tickets.rows[0].Status, 'valid');
  assert.equal(await orderCount(), 1);
});

test('?client=: also works in production\'s wrapped SQS message shape', async () => {
  await handler(buildSqsEvent([record({ wrapped: true, body: payload({ orderId: 'ORDER-URL-WRAPPED' }) })]));
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-URL-WRAPPED'`);
  assert.equal(orders.rows.length, 1);
});

test('?client=: swapping the client ID breaks the signature, order never processed', async (t) => {
  const rejections = captureRejections(t);
  // Square signed another venue's URL; the request claims to be for VENUE.
  await handler(buildSqsEvent([record({ signedUrl: urlFor('othervenue') })]));
  assert.equal(await orderCount(), 0);
  assert.equal(rejections().length, 1);
  assert.match(rejections()[0], /signature did not verify/);
});

test('?client=: a webhook from a different Square account is rejected even with a valid signature', async (t) => {
  const rejections = captureRejections(t);
  await handler(buildSqsEvent([record({ body: payload({ merchant: 'SOMEONEELSE' }) })]));
  assert.equal(await orderCount(), 0);
  assert.match(rejections()[0], /not this venue's Square account/);
});

test('?client=: refused for a venue that does not verify signatures (ENV_TYPE dev)', async (t) => {
  await setConfig({ ENV_TYPE: 'dev' });
  const rejections = captureRejections(t);
  await handler(buildSqsEvent([record()]));
  assert.equal(await orderCount(), 0);
  assert.match(rejections()[0], /does not verify Square signatures/);
});

test('?client=: refused for a venue with no SQUARE_MERCHANT_ID stored', async (t) => {
  await setConfig({ SQUARE_MERCHANT_ID: undefined });
  const rejections = captureRejections(t);
  await handler(buildSqsEvent([record()]));
  assert.equal(await orderCount(), 0);
  assert.match(rejections()[0], /no SQUARE_MERCHANT_ID/);
});

test('?client=: a malformed client ID is rejected before anything is looked up, batch still succeeds', async (t) => {
  const rejections = captureRejections(t);
  const result = await handler(buildSqsEvent([record({ client: '../etc/passwd' })]));
  assert.equal(result.statusCode, 200, 'the batch never fails (no-retry design)');
  assert.equal(await orderCount(), 0);
  assert.match(rejections()[0], /malformed client=/);
});

test('no ?client=: merchant_id is still the client ID (Liberty Hall\'s path), so this venue is not found that way', async () => {
  const body = payload({ orderId: 'ORDER-NO-CLIENT' });
  const signature = computeSquareSignature(BASE_URL, JSON.stringify(body), SIG_KEY);
  await handler(buildSqsEvent([buildSqsRecord(body, { 'x-square-hmacsha256-signature': signature })]));
  assert.equal(await orderCount(), 0, `looked up client ${MERCHANT}, which doesn't exist`);
});
