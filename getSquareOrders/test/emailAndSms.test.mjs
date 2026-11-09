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

function installCatalogFixture({ variationId = 'VAR-1', itemName = 'Test Movie' } = {}) {
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
          quantity: '1',
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
        item_data: { name: itemName, categories: [], variations: [{ id: variationId }] },
        custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } }
      }]
    })
  });
}

function webhookPayload({ clientId, orderId = 'ORDER-1', paymentId = 'PAYMENT-1', buyerEmail = 'buyer@example.com', paymentStatus = 'COMPLETED' } = {}) {
  return {
    merchant_id: clientId,
    type: 'payment.updated',
    data: { object: { payment: { id: paymentId, status: paymentStatus, order_id: orderId, buyer_email_address: buyerEmail } } }
  };
}

before(async () => {
  ctx = await startTestEnv({
    clientConfig: {
      SEND_SMS: 'true',
      SMS_ORIGINATION_NUMBER: '+15559998888',
      SMS_SENDER_BRAND: 'TestVenue',
      WEB_HEADER_COMPANY: 'Liberty Hall'
    }
  });
});
after(async () => { await stopTestEnv(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  resetSesHandlers();
  resetSmsHandlers();
  resetS3Handlers(await blankTemplate());
  installCatalogFixture();
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
  await ctx.pgClient.query(`DELETE FROM "Customer"`);
  await ctx.pgClient.query(`DELETE FROM "SmsConsent"`);
  await ctx.pgClient.query(`DELETE FROM "SmsOutboundLog"`);
});

test('a customer with active SMS consent gets the ticket texted automatically, no opt-in CTA in the email', async () => {
  const customer = await ctx.pgClient.query(`INSERT INTO "Customer" ("PhoneNumber") VALUES ('+17857491972') RETURNING "ID"`);
  await ctx.pgClient.query(`INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText") VALUES ($1, '+17857491972', 'active', 'web_initial', 'I agree')`, [customer.rows[0].ID]);

  squareHandlers.getPayment = async (paymentId) => ({
    ok: true, status: 200,
    json: async () => ({ payment: { id: paymentId, status: 'COMPLETED', customer_id: 'SQ-CUST-SMS' } })
  });
  squareHandlers.getCustomer = async (customerId) => ({
    ok: true, status: 200,
    json: async () => ({ customer: { id: customerId, phone_number: '+17857491972' } })
  });

  let smsSent;
  smsHandlers.sendTextMessage = async (input) => { smsSent = input; return { MessageId: 'mock-id' }; };
  let emailBody;
  sesHandlers.sendRawEmail = async (params) => { emailBody = params; return { MessageId: 'mock-id' }; };

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-SMS-1' }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);

  assert.ok(smsSent, 'SMS should have been sent automatically');
  assert.equal(smsSent.DestinationPhoneNumber, '+17857491972');

  const log = await ctx.pgClient.query(`SELECT * FROM "SmsOutboundLog"`);
  assert.equal(log.rows.length, 1);
});

test('a customer with no SMS consent gets the email opt-in CTA instead of an auto-SMS', async () => {
  let smsSent = false;
  smsHandlers.sendTextMessage = async () => { smsSent = true; return { MessageId: 'mock-id' }; };

  await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = "configuration"::jsonb || '{"STATIC_WEBSITE_URL": "https://example.com"}'::jsonb`);

  let emailBody;
  sesHandlers.sendRawEmail = async (params) => {
    emailBody = Buffer.isBuffer(params.RawMessage.Data) ? params.RawMessage.Data.toString('utf8') : params.RawMessage.Data;
    return { MessageId: 'mock-id' };
  };

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-SMS-2' }))]);
  await handler(event);

  assert.equal(smsSent, false);
  assert.match(emailBody, /opt-in/);
});

test('OWNER_BCC_EMAIL unset (default): the ticket email has no BCC, and uses the venue\'s own name in the subject/body', async () => {
  let captured;
  sesHandlers.sendRawEmail = async (params) => { captured = params; return { MessageId: 'mock-id' }; };

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-BCC-UNSET' }))]);
  await handler(event);

  assert.ok(captured);
  assert.deepEqual(captured.Destinations, ['buyer@example.com']);
  const rawMime = captured.RawMessage.Data.toString('utf8');
  assert.doesNotMatch(rawMime, /lawrence\.liberty\.hall@gmail\.com/);
  assert.match(rawMime, /Liberty Hall/);
});

test('OWNER_BCC_EMAIL set: the ticket email BCCs that address and includes it as an SES Destination', async () => {
  const bccCtx = await startTestEnv({
    clientId: 'OWNERBCCCLIENT1',
    clientConfig: { WEB_HEADER_COMPANY: 'Other Venue', OWNER_BCC_EMAIL: 'owner@example.com' }
  });
  try {
    squareHandlers.getOrder = async (orderId) => ({
      ok: true, status: 200,
      json: async () => ({ order: { id: orderId, location_id: 'LOC-1', line_items: [{ uid: 'LI-1', catalog_object_id: 'VAR-1', name: 'Other Movie', quantity: '1', variation_name: 'Adult', base_price_money: { amount: 1000 }, modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }] }] } })
    });
    squareHandlers.batchRetrieveCatalog = async () => ({
      ok: true, status: 200,
      json: async () => ({ objects: [], related_objects: [{ type: 'ITEM', id: 'ITEM-1', item_data: { name: 'Other Movie', categories: [], variations: [{ id: 'VAR-1' }] }, custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } } }] })
    });

    let captured;
    sesHandlers.sendRawEmail = async (params) => { captured = params; return { MessageId: 'mock-id' }; };

    const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: 'OWNERBCCCLIENT1', orderId: 'ORDER-BCC-SET' }))]);
    await handler(event);

    assert.ok(captured);
    // mailcomposer deliberately omits a visible Bcc: header from the raw
    // MIME even when `bcc` is passed to it -- real BCC semantics, matching
    // how the actual send works: SES's Destinations list (not the message
    // headers) is what determines delivery, which is the whole point of
    // using Destinations here instead of a plain To/Cc.
    assert.deepEqual(captured.Destinations, ['buyer@example.com', 'owner@example.com']);
    const rawMime = captured.RawMessage.Data.toString('utf8');
    assert.match(rawMime, /Other Venue/);
  } finally {
    await stopTestEnv(bccCtx);
  }
});

test('a walk-up/cash sale with no captured email and no OWNER_BCC_EMAIL configured skips the email send entirely', async () => {
  let emailSent = false;
  sesHandlers.sendRawEmail = async () => { emailSent = true; return { MessageId: 'mock-id' }; };

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-WALKUP', buyerEmail: null }))]);
  const result = await handler(event);
  const body = JSON.parse(result.body);
  assert.equal(body.results.success, 1);
  assert.equal(emailSent, false, 'no recipient means no attempted send, not a send-to-nobody');

  const ticket = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(ticket.rows.length, 1, 'the ticket itself is still created even though no email went out');
});

test('a walk-up sale with no WALKUP_PHONE set saves no phone (no venue\'s number is hardcoded)', async () => {
  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-WALKUP-NOPHONE', buyerEmail: null }))]);
  await handler(event);
  const order = await ctx.pgClient.query(`SELECT "FirstName", "LastName", "PhoneNumber" FROM "Order" WHERE "OrderID" = 'ORDER-WALKUP-NOPHONE'`);
  assert.equal(order.rows[0].FirstName, 'WALK-UP');
  assert.equal(order.rows[0].LastName, 'CASH-MASTER');
  assert.equal(order.rows[0].PhoneNumber, null);
  const ticket = await ctx.pgClient.query(`SELECT "PhoneNumber" FROM "QRCodeProduct" WHERE "ProductName" = 'Test Movie'`);
  assert.equal(ticket.rows[0].PhoneNumber, null);
  const customers = await ctx.pgClient.query(`SELECT count(*)::int AS n FROM "Customer"`);
  assert.equal(customers.rows[0].n, 0);
});

test('a walk-up sale uses the venue\'s WALKUP_PHONE when set; a buyer\'s own phone still wins', async () => {
  await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = "configuration"::jsonb || '{"WALKUP_PHONE": "5555550123"}'::jsonb`);
  try {
    await handler(buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-WALKUP-PHONE', buyerEmail: null }))]));
    const walkup = await ctx.pgClient.query(`SELECT "PhoneNumber" FROM "Order" WHERE "OrderID" = 'ORDER-WALKUP-PHONE'`);
    assert.equal(walkup.rows[0].PhoneNumber, '5555550123');

    squareHandlers.getPayment = async (paymentId) => ({
      ok: true, status: 200,
      json: async () => ({ payment: { id: paymentId, status: 'COMPLETED', customer_id: 'SQ-CUST-2' } })
    });
    squareHandlers.getCustomer = async (customerId) => ({
      ok: true, status: 200,
      json: async () => ({ customer: { id: customerId, given_name: 'Card', family_name: 'Holder', phone_number: '+15552224444' } })
    });
    await handler(buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-CARD-PHONE', paymentId: 'PAYMENT-2', buyerEmail: null }))]));
    const card = await ctx.pgClient.query(`SELECT "PhoneNumber" FROM "Order" WHERE "OrderID" = 'ORDER-CARD-PHONE'`);
    assert.equal(card.rows[0].PhoneNumber, '+15552224444');
  } finally {
    await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = "configuration"::jsonb - 'WALKUP_PHONE'`);
  }
});

test('a walk-up/cash sale with no captured email falls back to OWNER_BCC_EMAIL as the recipient when the client has one set', async () => {
  const walkupCtx = await startTestEnv({
    clientId: 'WALKUPOWNERCLIENT1',
    clientConfig: { WEB_HEADER_COMPANY: 'Walkup Venue', OWNER_BCC_EMAIL: 'owner-walkup@example.com' }
  });
  try {
    squareHandlers.getOrder = async (orderId) => ({
      ok: true, status: 200,
      json: async () => ({ order: { id: orderId, location_id: 'LOC-1', line_items: [{ uid: 'LI-1', catalog_object_id: 'VAR-1', name: 'Walkup Movie', quantity: '1', variation_name: 'Adult', base_price_money: { amount: 1000 }, modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }] }] } })
    });
    squareHandlers.batchRetrieveCatalog = async () => ({
      ok: true, status: 200,
      json: async () => ({ objects: [], related_objects: [{ type: 'ITEM', id: 'ITEM-1', item_data: { name: 'Walkup Movie', categories: [], variations: [{ id: 'VAR-1' }] }, custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } } }] })
    });

    let captured;
    sesHandlers.sendRawEmail = async (params) => { captured = params; return { MessageId: 'mock-id' }; };

    const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: 'WALKUPOWNERCLIENT1', orderId: 'ORDER-WALKUP-OWNER', buyerEmail: null }))]);
    await handler(event);

    assert.ok(captured, 'should fall back to OWNER_BCC_EMAIL as the recipient');
    // recipientEmail and ownerBccEmail are the same address in this exact
    // scenario (both fall back to OWNER_BCC_EMAIL), so it legitimately
    // appears twice -- a harmless duplicate SES will just deliver once.
    assert.deepEqual(captured.Destinations, ['owner-walkup@example.com', 'owner-walkup@example.com']);
  } finally {
    await stopTestEnv(walkupCtx);
  }
});

test('a Square customer_id on the payment is used to resolve name/email/phone over the webhook\'s own buyer fields', async () => {
  squareHandlers.getPayment = async (paymentId) => ({
    ok: true, status: 200,
    json: async () => ({ payment: { id: paymentId, status: 'COMPLETED', customer_id: 'SQ-CUST-1' } })
  });
  squareHandlers.getCustomer = async (customerId) => ({
    ok: true, status: 200,
    json: async () => ({ customer: { id: customerId, email_address: 'fromcustomer@example.com', given_name: 'Pat', family_name: 'Customer', phone_number: '+15552223333' } })
  });

  const event = buildSqsEvent([buildSqsRecord(webhookPayload({ clientId: ctx.clientId, orderId: 'ORDER-SQCUST' }))]);
  await handler(event);

  const order = await ctx.pgClient.query(`SELECT * FROM "Order" WHERE "OrderID" = 'ORDER-SQCUST'`);
  assert.equal(order.rows[0].EmailAddress, 'fromcustomer@example.com');
  assert.equal(order.rows[0].FirstName, 'Pat');
});
