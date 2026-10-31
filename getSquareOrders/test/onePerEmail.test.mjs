import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
// Must be imported BEFORE '../src/index.mjs' -- see processWebhook.test.mjs.
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  s3Handlers, resetS3Handlers,
  sesHandlers, resetSesHandlers,
  resetSmsHandlers,
  buildSqsEvent, buildSqsRecord
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

let ctx;
let emailsSent;

before(async () => { ctx = await startTestEnv(); });
after(async () => { await stopTestEnv(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  resetSesHandlers();
  resetSmsHandlers();
  const doc = await PDFDocument.create();
  doc.addPage([1800, 600]);
  resetS3Handlers(Buffer.from(await doc.save()));
  emailsSent = 0;
  sesHandlers.sendRawEmail = async () => { emailsSent++; return { MessageId: 'mock-id' }; };
  for (const table of ['QRCodeProductToOrder', 'QRCodeProduct', 'Order', 'Customer', 'SmsConsent']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`);
  }
  await setLimit(null);
});

async function setLimit(value) {
  await ctx.pgClient.query(
    `UPDATE "Client" SET configuration = (configuration::jsonb || jsonb_build_object('ONE_PER_EMAIL_ITEMS', $1::text))::json`,
    [value]
  );
}

// One order with the given line items: [{ name, quantity }]
function installOrder(lines) {
  squareHandlers.getOrder = async (orderId) => ({
    ok: true, status: 200,
    json: async () => ({
      order: {
        id: orderId, location_id: 'LOC-1',
        line_items: lines.map((line, i) => ({
          uid: `LI-${i}`, catalog_object_id: `VAR-${i}`, name: line.name, quantity: String(line.quantity || 1),
          variation_name: 'Adult', base_price_money: { amount: 0 },
          modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }]
        }))
      }
    })
  });
  squareHandlers.batchRetrieveCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [],
      related_objects: lines.map((line, i) => ({
        type: 'ITEM', id: `ITEM-${i}`,
        item_data: { name: line.name, categories: [], variations: [{ id: `VAR-${i}` }] },
        custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } }
      }))
    })
  });
}

async function buy(orderId, buyerEmail) {
  const payload = {
    merchant_id: ctx.clientId, type: 'payment.updated',
    data: { object: { payment: { id: `PAY-${orderId}`, status: 'COMPLETED', order_id: orderId, buyer_email_address: buyerEmail } } }
  };
  await handler(buildSqsEvent([buildSqsRecord(payload)]));
}

const ticketCount = async (name) =>
  (await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "QRCodeProduct" WHERE "ProductName" = $1`, [name])).rows[0].n;

test('ONE_PER_EMAIL_ITEMS unset: repeat orders of the same item all get tickets (no change)', async () => {
  installOrder([{ name: 'Free Sample' }]);
  await buy('O-1', 'fan@example.com');
  await buy('O-2', 'fan@example.com');
  assert.equal(await ticketCount('Free Sample'), 2);
  assert.equal(emailsSent, 2);
});

test('ONE_PER_EMAIL_ITEMS: a second order from the same email gets no ticket and no email', async () => {
  await setLimit('Free Sample');
  installOrder([{ name: 'Free Sample' }]);
  await buy('O-1', 'fan@example.com');
  await buy('O-2', 'FAN@example.com ');
  assert.equal(await ticketCount('Free Sample'), 1);
  assert.equal(emailsSent, 1);
  const orders = await ctx.pgClient.query(`SELECT "OrderID" FROM "Order"`);
  assert.deepEqual(orders.rows.map(r => r.OrderID), ['O-1']);
});

test('ONE_PER_EMAIL_ITEMS: a different email still gets its own sample', async () => {
  await setLimit('free sample');
  installOrder([{ name: 'Free Sample' }]);
  await buy('O-1', 'fan@example.com');
  await buy('O-2', 'other@example.com');
  assert.equal(await ticketCount('Free Sample'), 2);
});

test('ONE_PER_EMAIL_ITEMS: quantity 3 in one order makes one ticket', async () => {
  await setLimit('Free Sample');
  installOrder([{ name: 'Free Sample', quantity: 3 }]);
  await buy('O-1', 'fan@example.com');
  assert.equal(await ticketCount('Free Sample'), 1);
});

test('ONE_PER_EMAIL_ITEMS: other items in the same order are untouched', async () => {
  await setLimit('Free Sample, Another Freebie');
  installOrder([{ name: 'Free Sample' }]);
  await buy('O-1', 'fan@example.com');
  installOrder([{ name: 'Free Sample' }, { name: 'Real Movie', quantity: 2 }]);
  await buy('O-2', 'fan@example.com');
  assert.equal(await ticketCount('Free Sample'), 1);
  assert.equal(await ticketCount('Real Movie'), 2);
  assert.equal(emailsSent, 2);
});
