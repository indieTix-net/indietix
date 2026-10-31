import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  s3Handlers, resetS3Handlers,
  sesHandlers, resetSesHandlers,
  smsHandlers, resetSmsHandlers,
  buildSqsEvent, buildSqsRecord
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

let ctx;

async function blankTemplate(width = 1800, height = 600) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

function webhookPayload({ clientId, orderId = 'ORDER-1', paymentId = 'PAYMENT-1', buyerEmail = 'buyer@example.com' } = {}) {
  return {
    merchant_id: clientId,
    type: 'payment.updated',
    data: { object: { payment: { id: paymentId, status: 'COMPLETED', order_id: orderId, buyer_email_address: buyerEmail } } }
  };
}

before(async () => { ctx = await startTestEnv(); });
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
});

test('a line item with quantity > 1 creates one ticket per unit, each with a unique QR code', async () => {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId, location_id: 'LOC-1',
        line_items: [{ uid: 'LI-QTY', catalog_object_id: 'VAR-1', name: 'Test Movie', quantity: '3', variation_name: 'Adult', total_money: { amount: 3750 }, modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }] }]
      }
    })
  });
  squareHandlers.batchRetrieveCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({ objects: [], related_objects: [{ type: 'ITEM', id: 'ITEM-1', item_data: { name: 'Test Movie', categories: [], variations: [{ id: 'VAR-1' }] }, custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } } }] })
  });

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-QTY' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);

  const tickets = await ctx.pgClient.query(`SELECT "QRCode" FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(tickets.rows.length, 3);
  const uniqueCodes = new Set(tickets.rows.map(r => r.QRCode));
  assert.equal(uniqueCodes.size, 3, 'every unit must get its own unique QR code');

  const links = await ctx.pgClient.query(`SELECT * FROM "QRCodeProductToOrder"`);
  assert.equal(links.rows.length, 3, 'all 3 tickets must link back to the single Order row');
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order"`);
  assert.equal(orders.rows.length, 1, 'one Order row regardless of ticket quantity');
});

test('Distributor and EventType custom attributes are resolved via their selection IDs', async () => {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId, location_id: 'LOC-1',
        line_items: [{ uid: 'LI-DIST', catalog_object_id: 'VAR-1', name: 'Test Movie', quantity: '1', variation_name: 'Adult', base_price_money: { amount: 1250 }, modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }] }]
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
        custom_attribute_values: {
          attr1: { name: 'UseQRCode', boolean_value: true },
          attr2: { name: 'Distributor', type: 'SELECTION', custom_attribute_definition_id: 'DEF-DIST', selection_uid_values: ['SEL-DIST-1'] },
          attr3: { name: 'EventType', type: 'SELECTION', custom_attribute_definition_id: 'DEF-ETYPE', selection_uid_values: ['SEL-ETYPE-1'] }
        }
      }]
    })
  });
  squareHandlers.getCatalogObject = async (objectId) => {
    if (objectId === 'DEF-DIST') {
      return { ok: true, status: 200, json: async () => ({ object: { custom_attribute_definition_data: { selection_config: { allowed_selections: [{ uid: 'SEL-DIST-1', name: 'Warner Bros' }] } } } }) };
    }
    if (objectId === 'DEF-ETYPE') {
      return { ok: true, status: 200, json: async () => ({ object: { custom_attribute_definition_data: { selection_config: { allowed_selections: [{ uid: 'SEL-ETYPE-1', name: 'Movie' }] } } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ object: {} }) };
  };

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-DIST' }))]);
  await handler(event);

  const ticket = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(ticket.rows.length, 1);
  assert.equal(ticket.rows[0].Distributor, 'Warner Bros');
  assert.equal(ticket.rows[0].ProductType, 'Movie');
});

test('an unresolvable Distributor/EventType selection ID falls back to "Unknown" rather than failing the ticket', async () => {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId, location_id: 'LOC-1',
        line_items: [{ uid: 'LI-UNK', catalog_object_id: 'VAR-1', name: 'Test Movie', quantity: '1', variation_name: 'Adult', base_price_money: { amount: 1250 }, modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }] }]
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
        custom_attribute_values: {
          attr1: { name: 'UseQRCode', boolean_value: true },
          attr2: { name: 'Distributor', type: 'SELECTION', custom_attribute_definition_id: 'DEF-DIST', selection_uid_values: ['SEL-NOT-FOUND'] }
        }
      }]
    })
  });
  squareHandlers.getCatalogObject = async () => ({ ok: true, status: 200, json: async () => ({ object: { custom_attribute_definition_data: { selection_config: { allowed_selections: [] } } } }) });

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-UNK' }))]);
  await handler(event);

  const ticket = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(ticket.rows.length, 1);
  assert.equal(ticket.rows[0].Distributor, 'Unknown');
});

// ---- Square API failures ----

// processWebhook's own outer try/catch swallows virtually every error
// (Square API failures included) and returns a {statusCode: 500, ...}
// body as a normal return value, never throwing -- so the handler's own
// results.success/failure counters (which only move on an exception
// escaping processWebhook entirely) stay at success:1 for these. That's
// the documented "always mark the message handled, no SQS retry" design
// working as intended; the real signal to check is that nothing got
// written, not the batch-level counters.

test('a Square Orders API failure is handled cleanly -- no Order row created, no crash', async () => {
  squareHandlers.getOrder = async () => ({ ok: false, status: 500, text: async () => 'square down' });
  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-SQFAIL' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1, 'counted as handled per the no-retry design, even though nothing was actually created');
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-SQFAIL'`);
  assert.equal(orders.rows.length, 0);
});

test('a Square Payments API failure is handled cleanly -- no Order row created, no crash', async () => {
  squareHandlers.getPayment = async () => ({ ok: false, status: 500, json: async () => ({ errors: [{ detail: 'boom' }] }) });
  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-PAYFAIL' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);
  const orders = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-PAYFAIL'`);
  assert.equal(orders.rows.length, 0);
});

test('one record failing against Square does not block a sibling record in the same batch from succeeding', async () => {
  squareHandlers.getOrder = async (orderId) => {
    if (orderId === 'ORDER-WILLFAIL') return { ok: false, status: 500, text: async () => 'square down' };
    return { ok: true, status: 200, json: async () => ({ order: { id: orderId, location_id: 'LOC-1', line_items: [] } }) };
  };
  const event = buildSqsEvent([
    buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-WILLFAIL', paymentId: 'PAY-FAIL' })),
    buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-WILLSUCCEED', paymentId: 'PAY-OK' }))
  ]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 2, 'both are counted as "handled" per the no-retry design');

  const failedOrder = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-WILLFAIL'`);
  assert.equal(failedOrder.rows.length, 0);
  const succeededOrder = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-WILLSUCCEED'`);
  assert.equal(succeededOrder.rows.length, 0, 'this one has no UseQRCode line items either way, but it must have been REACHED (not short-circuited by its sibling failing)');
});
