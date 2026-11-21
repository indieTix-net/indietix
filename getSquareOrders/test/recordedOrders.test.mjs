import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
// Must be imported BEFORE '../src/index.mjs' (see processWebhook.test.mjs).
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  resetS3Handlers, resetSesHandlers, resetSmsHandlers, sesHandlers, smsHandlers,
  buildSqsEvent, buildSqsRecord, computeSquareSignature
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

// ---- Recorded real orders (characterization tests) ----
// Each fixture in fixtures/liberty-hall/ is one real Liberty Hall sale,
// recorded from production's getSquareOrders logs (webhook, Square's payment,
// customer, order and catalog responses) together with the ticket rows
// production actually wrote for it. Personal data is replaced with fakes.
// These tests replay the recording through the handler and require the same
// rows, so any change to the sale path (native events, the POS split) has to
// keep producing what production produces today. See fixtures/README.md.

const FIXTURE_DIR = new URL('./fixtures/liberty-hall/', import.meta.url);
const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURE_DIR))));

const CLIENT_ID = 'LHFIXTUREMERCHANT'; // the fixtures' anonymized merchant_id
const SIG_KEY = 'recorded-orders-sig-key';
const WEBHOOK_URL = 'https://example.com/prod/webhook';

// Liberty Hall's settings that affect a sale (read from production 2026-11-20;
// personal values replaced by the same fakes the fixtures use).
const LIBERTY_HALL_CONFIG = {
  ENV_TYPE: 'prod',
  SQUARE_SIGNATURE_KEY: SIG_KEY,
  SQUARE_WEBHOOK_URL: WEBHOOK_URL,
  USE_QR_CODE: 'UseQRCode',
  DISTRIBUTOR_NAME: 'Distributor',
  EVENT_TYPE: 'EventType',
  WEB_HEADER_COMPANY: 'Liberty Hall',
  SEND_SMS: 'true',
  SMS_ORIGINATION_NUMBER: '+15559990000',
  ONE_PER_EMAIL_ITEMS: '',
  OWNER_BCC_EMAIL: 'owner@example.com',
  WALKUP_PHONE: '+15555550100',
  STATIC_WEBSITE_URL: 'https://static.example.com'
};

let ctx;

async function blankTemplate(width = 1800, height = 600) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

before(async () => {
  ctx = await startTestEnv({ clientId: CLIENT_ID, clientConfig: LIBERTY_HALL_CONFIG });
});
after(async () => { await stopTestEnv(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  resetSesHandlers();
  resetSmsHandlers();
  resetS3Handlers(await blankTemplate());
  for (const table of ['QRCodeProductToOrder', 'QRCodeProduct', 'Order', 'Customer', 'SmsConsent']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`);
  }
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const notFound = () => ({ ok: false, status: 404, json: async () => ({ errors: [{ code: 'NOT_FOUND' }] }), text: async () => 'not found' });

// Square answers exactly what it answered in production.
function installRecording(fx) {
  const calls = { catalogIds: null, customers: [], definitions: [] };
  squareHandlers.getPayment = async (id) => (id === fx.payment.payment.id ? ok(fx.payment) : notFound());
  squareHandlers.getOrder = async (id) => (id === fx.order.order.id ? ok(fx.order) : notFound());
  squareHandlers.getCustomer = async (id) => {
    calls.customers.push(id);
    return fx.customer && fx.customer.customer?.id === id ? ok(fx.customer) : notFound();
  };
  squareHandlers.batchRetrieveCatalog = async (body) => { calls.catalogIds = body.object_ids; return ok(fx.catalog); };
  squareHandlers.getCatalogObject = async (id) => {
    calls.definitions.push(id);
    const selections = fx.selectionDefinitions[id];
    if (!selections) return notFound();
    return ok({ object: { id, type: 'CUSTOM_ATTRIBUTE_DEFINITION', custom_attribute_definition_data: { selection_config: { allowed_selections: selections } } } });
  };
  return calls;
}

function captureOutbound() {
  const emails = [];
  const texts = [];
  sesHandlers.sendRawEmail = async (params) => { emails.push(params); return { MessageId: 'mock-ses-id' }; };
  smsHandlers.sendTextMessage = async (input) => { texts.push(input); return { MessageId: 'mock-sms-id' }; };
  return { emails, texts };
}

function signedRecord(webhook) {
  const body = JSON.stringify(webhook);
  return buildSqsRecord(webhook, { 'x-square-hmacsha256-signature': computeSquareSignature(WEBHOOK_URL, body, SIG_KEY) });
}

for (const fx of fixtures) {
  test(`recorded order "${fx.shape}": ${fx.description}`, async () => {
    assert.equal(fx.webhook.merchant_id, CLIENT_ID, 'fixture merchant_id must be the anonymized one');
    if (fx.payment.payment.customer_id) assert.ok(fx.customer, 'payment names a customer, so the recording must include it');

    const calls = installRecording(fx);
    const outbound = captureOutbound();

    const result = await handler(buildSqsEvent([signedRecord(fx.webhook)]));
    assert.equal(JSON.parse(result.body).results.success, 1);

    // Square was asked for the catalog objects on the order's line items.
    const lineItemIds = (fx.order.order.line_items || []).map((l) => l.catalog_object_id).filter(Boolean);
    assert.deepEqual(calls.catalogIds, lineItemIds);
    if (fx.payment.payment.customer_id) assert.deepEqual(calls.customers, [fx.payment.payment.customer_id]);

    const orders = await ctx.pgClient.query(`SELECT * FROM "Order"`);
    const tickets = await ctx.pgClient.query(`
      SELECT "QRCode", "ProductDate"::text AS "ProductDate", "ProductName", "ProductLocation", "ProductType",
             "ProductDetails", "ProductPrice", "ProductID", "EmailAddress", "FirstName", "LastName", "PhoneNumber",
             "Distributor", "ProductVenue", "ProductSeatCode", "Status", "ProductMetadata"::text AS "ProductMetadata"
      FROM "QRCodeProduct" ORDER BY "ID"`);

    if (!fx.expected.order) {
      assert.equal(orders.rows.length, 0, 'no Order row for a sale with no tickets');
      assert.equal(tickets.rows.length, 0);
      assert.equal(outbound.emails.length, 0, 'no email for a sale with no tickets');
      assert.equal(outbound.texts.length, 0);
      return;
    }

    // ---- the Order row ----
    assert.equal(orders.rows.length, 1);
    const order = orders.rows[0];
    assert.equal(order.OrderID, fx.order.order.id);
    for (const [k, v] of Object.entries(fx.expected.order)) assert.equal(order[k], v, `Order.${k}`);
    assert.deepEqual(order.OrderMetaData, fx.order, 'Order.OrderMetaData is Square\'s order response, unchanged');
    assert.match(order.OptInToken, /^[A-Za-z0-9_-]{20,}$/);

    // ---- one QRCodeProduct row per ticket, same values production wrote ----
    assert.equal(tickets.rows.length, fx.expected.tickets.length, 'ticket count');
    tickets.rows.forEach((row, i) => {
      const want = fx.expected.tickets[i];
      const label = `ticket ${i + 1} of ${tickets.rows.length}`;
      for (const k of ['ProductName', 'ProductDate', 'ProductLocation', 'ProductType', 'ProductDetails', 'ProductID',
        'EmailAddress', 'FirstName', 'LastName', 'PhoneNumber', 'Distributor', 'ProductVenue', 'ProductSeatCode', 'Status']) {
        assert.equal(row[k], want[k], `${label}: ${k}`);
      }
      assert.equal(Number(row.ProductPrice), want.ProductPrice, `${label}: ProductPrice`);
      assert.ok(row.QRCode.startsWith(want.QRCodePrefix), `${label}: QRCode starts with item_variation_order_uid_`);
      assert.deepEqual(JSON.parse(row.ProductMetadata), want.ProductMetadata, `${label}: ProductMetadata`);
    });
    assert.equal(new Set(tickets.rows.map((r) => r.QRCode)).size, tickets.rows.length, 'every QR code is unique');

    // ---- one email with every ticket attached; no text (no SMS consent yet) ----
    assert.equal(outbound.emails.length, 1, 'one ticket email');
    const email = outbound.emails[0];
    const raw = Buffer.from(email.RawMessage.Data).toString('utf8');
    assert.equal(email.Destinations[0], fx.expected.emailRecipient);
    assert.equal((raw.match(/Content-Disposition: attachment/gi) || []).length, fx.expected.tickets.length, 'one PDF per ticket');
    assert.match(raw, /opt-in/, 'no SMS consent yet, so the email offers the text opt-in');
    assert.equal(outbound.texts.length, 0);

    // ---- Square's other webhooks for the same sale change nothing ----
    await handler(buildSqsEvent([signedRecord(fx.webhook)]));
    assert.equal((await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "QRCodeProduct"`)).rows[0].n, fx.expected.tickets.length);
    assert.equal(outbound.emails.length, 1);
  });
}

test('the recordings cover every order shape listed in fixtures/README.md', () => {
  const readme = readFileSync(new URL('../README.md', FIXTURE_DIR), 'utf8');
  for (const fx of fixtures) assert.ok(readme.includes(`\`${fx.shape}\``), `${fx.shape} is described in the README`);
});
