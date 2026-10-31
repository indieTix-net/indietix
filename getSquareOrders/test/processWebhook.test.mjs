import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
// Must be imported BEFORE '../src/index.mjs' -- this harness patches
// pg.Pool so test-created pools can be closed on teardown; index.mjs's
// own `const { Pool } = pg` destructure needs to see the patched version,
// which only happens if this import evaluates first. See the harness file
// for the full explanation.
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  s3Handlers, resetS3Handlers,
  sesHandlers, resetSesHandlers,
  smsHandlers, resetSmsHandlers,
  buildSqsEvent, buildSqsRecord, computeSquareSignature
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

let ctx;

async function blankTemplate(width = 1800, height = 600) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

before(async () => {
  ctx = await startTestEnv();
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
  await ctx.pgClient.query(`DELETE FROM "Customer"`);
  await ctx.pgClient.query(`DELETE FROM "SmsConsent"`);
});

function installCatalogFixture({ variationId = 'VAR-1', itemName = 'Test Movie', quantity = '1' } = {}) {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId,
        location_id: 'LOC-1',
        line_items: [{
          uid: 'LI-1',
          catalog_object_id: variationId,
          name: itemName,
          quantity,
          variation_name: 'Adult',
          base_price_money: { amount: 1250 },
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
        type: 'ITEM',
        id: 'ITEM-1',
        item_data: {
          name: itemName,
          categories: [],
          variations: [{ id: variationId }]
        },
        custom_attribute_values: {
          attr1: { name: 'UseQRCode', boolean_value: true }
        }
      }]
    })
  });
}

function webhookPayload({ clientId = ctx.clientId, orderId = 'ORDER-1', paymentId = 'PAYMENT-1', buyerEmail = 'buyer@example.com', paymentStatus = 'COMPLETED' } = {}) {
  return {
    merchant_id: clientId,
    type: 'payment.updated',
    data: {
      object: {
        payment: {
          id: paymentId,
          status: paymentStatus,
          order_id: orderId,
          buyer_email_address: buyerEmail
        }
      }
    }
  };
}

test('handler: happy path -- generates a ticket, saves to DB, and emails the PDF', async () => {
  installCatalogFixture();
  let capturedEmail;
  sesHandlers.sendRawEmail = async (params) => { capturedEmail = params; return { MessageId: 'mock-id' }; };

  const event = buildSqsEvent([buildSqsRecord(webhookPayload())]);
  const result = await handler(event);

  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);
  assert.equal(body.results.failure, 0);

  const order = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-1'`);
  assert.equal(order.rows.length, 1);
  assert.equal(order.rows[0].EmailAddress, 'buyer@example.com');
  assert.ok(order.rows[0].OptInToken);

  const tickets = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(tickets.rows.length, 1);
  assert.equal(tickets.rows[0].Status, 'valid');

  assert.ok(capturedEmail, 'an email should have been sent');
});

test('handler: a batch with multiple records all succeed independently', async () => {
  installCatalogFixture();
  const event = buildSqsEvent([
    buildSqsRecord(webhookPayload({ orderId: 'ORDER-BATCH-1', paymentId: 'PAYMENT-BATCH-1' })),
    buildSqsRecord(webhookPayload({ orderId: 'ORDER-BATCH-2', paymentId: 'PAYMENT-BATCH-2' }))
  ]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 2);

  const orders = await ctx.pgClient.query(`SELECT "OrderID" FROM "Order" ORDER BY "OrderID"`);
  assert.deepEqual(orders.rows.map(r => r.OrderID), ['ORDER-BATCH-1', 'ORDER-BATCH-2']);
});

test('handler: missing merchant_id is rejected per-record but never fails the whole batch (no retry design)', async () => {
  const badPayload = { type: 'payment.updated', data: { object: { payment: { id: 'X', status: 'COMPLETED', order_id: 'ORDER-X' } } } };
  const event = buildSqsEvent([buildSqsRecord(badPayload)]);
  const result = await handler(event);
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1, 'processWebhook returns its own 401 body, which the handler counts as a successfully-processed message');
});

test('handler: an unknown clientId is rejected cleanly, not a crash', async () => {
  installCatalogFixture();
  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: 'NOSUCHCLIENT999' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);
  assert.equal(body.results.failure, 0);
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order"`);
  assert.equal(orders.rows.length, 0, 'nothing should have been written for the real test client');
});

test('handler: a non-COMPLETED payment status is a clean no-op, no ticket created', async () => {
  installCatalogFixture();
  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ paymentStatus: 'PENDING' }))]);
  await handler(event);
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order"`);
  assert.equal(orders.rows.length, 0);
});

test('handler: a duplicate webhook for an already-processed order is an idempotent no-op', async () => {
  installCatalogFixture();
  const payload = webhookPayload({ orderId: 'ORDER-DUP' });
  await handler(buildSqsEvent([buildSqsRecord(payload)]));
  const firstCount = await ctx.pgClient.query(`SELECT COUNT(*) FROM "QRCodeProduct"`);

  await handler(buildSqsEvent([buildSqsRecord({ ...payload, data: { object: { payment: { ...payload.data.object.payment, id: 'PAYMENT-DUP-2' } } } })]));
  const secondCount = await ctx.pgClient.query(`SELECT COUNT(*) FROM "QRCodeProduct"`);
  assert.equal(secondCount.rows[0].count, firstCount.rows[0].count, 'the duplicate order must not create a second ticket');
});

test('handler: an order with no UseQRCode line items (bar/concession sale) is an explicit no-op, not undefined', async () => {
  // Catalog has no UseQRCode-flagged items -- matches the documented
  // 2026-10-21 landmine: this path
  // used to implicitly return undefined, which crashed a later attempt
  // at SQS retry classification.
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({ order: { id: orderId, location_id: 'LOC-1', line_items: [{ uid: 'LI-BAR', catalog_object_id: 'BAR-ITEM', name: 'Popcorn', quantity: '1', base_price_money: { amount: 500 } }] } })
  });
  squareHandlers.batchRetrieveCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [], related_objects: [] }) });

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ orderId: 'ORDER-BAR' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);
  assert.equal(body.results.failure, 0);
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-BAR'`);
  assert.equal(orders.rows.length, 0);
});

// ---- ENV_TYPE=prod signature verification ----

test('handler (prod): a valid Square signature is accepted', async () => {
  const prodCtx = await startTestEnv({
    clientId: 'PRODSIGCLIENT1',
    clientConfig: { ENV_TYPE: 'prod', SQUARE_SIGNATURE_KEY: 'test-sig-key', SQUARE_WEBHOOK_URL: 'https://example.com/webhook' }
  });
  try {
    squareHandlers.getOrder = async (orderId) => ({ ok: true, status: 200, json: async () => ({ order: { id: orderId, location_id: 'LOC-1', line_items: [] } }) });
    squareHandlers.batchRetrieveCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [], related_objects: [] }) });

    const payload = webhookPayload({ clientId: 'PRODSIGCLIENT1', orderId: 'ORDER-PROD-1' });
    const bodyStr = JSON.stringify(payload);
    const signature = computeSquareSignature('https://example.com/webhook', bodyStr, 'test-sig-key');
    const record = buildSqsRecord(payload, { 'x-square-hmacsha256-signature': signature });

    const result = await handler(buildSqsEvent([record]));
    const body = JSON.parse(result.body);
    assert.equal(body.results.success, 1);
    assert.equal(body.results.failure, 0);
  } finally {
    await stopTestEnv(prodCtx);
  }
});

test('handler (prod): an invalid Square signature is rejected, order never processed', async () => {
  const prodCtx = await startTestEnv({
    clientId: 'PRODSIGCLIENT2',
    clientConfig: { ENV_TYPE: 'prod', SQUARE_SIGNATURE_KEY: 'test-sig-key', SQUARE_WEBHOOK_URL: 'https://example.com/webhook' }
  });
  try {
    const payload = webhookPayload({ clientId: 'PRODSIGCLIENT2', orderId: 'ORDER-PROD-BAD' });
    const record = buildSqsRecord(payload, { 'x-square-hmacsha256-signature': 'totally-wrong-signature' });

    await handler(buildSqsEvent([record]));
    const orders = await prodCtx.pgClient.query(`SELECT * FROM "Order"`);
    assert.equal(orders.rows.length, 0);
  } finally {
    await stopTestEnv(prodCtx);
  }
});

test('handler (prod): a missing signature header is rejected', async () => {
  const prodCtx = await startTestEnv({
    clientId: 'PRODSIGCLIENT3',
    clientConfig: { ENV_TYPE: 'prod', SQUARE_SIGNATURE_KEY: 'test-sig-key', SQUARE_WEBHOOK_URL: 'https://example.com/webhook' }
  });
  try {
    const payload = webhookPayload({ clientId: 'PRODSIGCLIENT3', orderId: 'ORDER-PROD-NOHEADER' });
    const record = buildSqsRecord(payload, {});

    await handler(buildSqsEvent([record]));
    const orders = await prodCtx.pgClient.query(`SELECT * FROM "Order"`);
    assert.equal(orders.rows.length, 0);
  } finally {
    await stopTestEnv(prodCtx);
  }
});

// ---- parseItemModifierValues: unparseable modifier string ----

test('handler: a line item whose modifier string fails to parse as a date still creates a ticket', async () => {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId,
        location_id: 'LOC-1',
        line_items: [{
          uid: 'LI-BADDATE',
          catalog_object_id: 'VAR-1',
          name: 'Test Movie',
          quantity: '1',
          variation_name: 'Adult',
          base_price_money: { amount: 1250 },
          modifiers: [{ name: 'Totally Not A Date (Main Theater)' }]
        }]
      }
    })
  });
  squareHandlers.batchRetrieveCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [],
      related_objects: [{
        type: 'ITEM',
        id: 'ITEM-1',
        item_data: { name: 'Test Movie', categories: [], variations: [{ id: 'VAR-1' }] },
        custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } }
      }]
    })
  });

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ orderId: 'ORDER-BADDATE' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);

  const tickets = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(tickets.rows.length, 1, 'a paid order must never silently lose its ticket just because the showtime string was unparseable');
  assert.ok(tickets.rows[0].ProductDate, 'falls back to a "now" timestamp rather than a null ProductDate');
});
