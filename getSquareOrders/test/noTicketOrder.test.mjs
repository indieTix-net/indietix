import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
// Must be imported BEFORE '../src/index.mjs' (see processWebhook.test.mjs).
import {
  startTestEnv, stopTestEnv,
  squareHandlers, resetSquareHandlers,
  resetS3Handlers, resetSesHandlers, resetSmsHandlers,
  buildSqsEvent, buildSqsRecord
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

// ---- NoTicketOrder: concession sales are processed once ----
// The recorded concessions-only sale in recordedOrders.test.mjs covers the
// normal case. These cover the two edges: a failed catalog fetch must not
// be remembered as "no tickets", and a venue database without the table
// still works.

let ctx;
let orderFetches;

before(async () => { ctx = await startTestEnv({ clientId: 'NOTICKETVENUE' }); });
after(async () => { await stopTestEnv(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  resetSesHandlers();
  resetSmsHandlers();
  const doc = await PDFDocument.create();
  doc.addPage([1800, 600]);
  resetS3Handlers(Buffer.from(await doc.save()));
  for (const table of ['QRCodeProductToOrder', 'QRCodeProduct', 'Order', 'NoTicketOrder']) {
    await ctx.pgClient.query(`DELETE FROM "${table}"`);
  }
  orderFetches = 0;
  squareHandlers.getOrder = async (orderId) => {
    orderFetches++;
    return {
      ok: true, status: 200,
      json: async () => ({
        order: {
          id: orderId, location_id: 'LOC-1',
          line_items: [{ uid: 'LI-1', catalog_object_id: 'VAR-1', name: 'Test Movie', quantity: '1', variation_name: 'Adult',
            base_price_money: { amount: 1250 }, total_money: { amount: 1250 }, modifiers: [{ name: 'Sun 01-04-2026 7:00 PM (Main Theater)' }] }]
        }
      })
    };
  };
});

const ticketCatalog = async () => ({
  ok: true, status: 200,
  json: async () => ({
    objects: [],
    related_objects: [{ type: 'ITEM', id: 'ITEM-1', item_data: { name: 'Test Movie', variations: [{ id: 'VAR-1' }] },
      custom_attribute_values: { a: { name: 'UseQRCode', boolean_value: true } } }]
  })
});
const concessionCatalog = async () => ({
  ok: true, status: 200,
  json: async () => ({ objects: [], related_objects: [{ type: 'ITEM', id: 'ITEM-1', item_data: { name: 'Soda', variations: [{ id: 'VAR-1' }] } }] })
});

function record(orderId) {
  return buildSqsRecord({
    merchant_id: ctx.clientId, type: 'payment.updated',
    data: { object: { payment: { id: `PAY-${orderId}`, status: 'COMPLETED', order_id: orderId, buyer_email_address: 'buyer@example.com' } } }
  });
}
const count = async (table) => (await ctx.pgClient.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)).rows[0].n;

test('a concession sale is remembered, and its repeat webhooks never reach Square', async () => {
  squareHandlers.batchRetrieveCatalog = concessionCatalog;
  await handler(buildSqsEvent([record('ORDER-SODA')]));
  await handler(buildSqsEvent([record('ORDER-SODA'), record('ORDER-SODA')]));
  assert.equal(orderFetches, 1);
  assert.equal(await count('NoTicketOrder'), 1);
  assert.equal(await count('Order'), 0);
});

test('a failed catalog fetch is NOT remembered: the next webhook retries and issues the ticket', async () => {
  squareHandlers.batchRetrieveCatalog = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'Square is down' });
  await handler(buildSqsEvent([record('ORDER-FLAKY')]));
  assert.equal(await count('NoTicketOrder'), 0, 'not recorded as having no tickets');
  assert.equal(await count('QRCodeProduct'), 0);

  squareHandlers.batchRetrieveCatalog = ticketCatalog;
  await handler(buildSqsEvent([record('ORDER-FLAKY')]));
  assert.equal(await count('QRCodeProduct'), 1, 'the repeat webhook got the ticket issued');
  assert.equal(await count('Order'), 1);
});

test('remembered entries older than 90 days are pruned', async () => {
  await ctx.pgClient.query(`INSERT INTO "NoTicketOrder" ("OrderID", "CreatedDate") VALUES ('OLD-ONE', NOW() - INTERVAL '91 days'), ('RECENT-ONE', NOW() - INTERVAL '89 days')`);
  squareHandlers.batchRetrieveCatalog = concessionCatalog;
  await handler(buildSqsEvent([record('ORDER-NEW')]));
  const ids = (await ctx.pgClient.query(`SELECT "OrderID" FROM "NoTicketOrder" ORDER BY "OrderID"`)).rows.map((r) => r.OrderID);
  assert.deepEqual(ids, ['ORDER-NEW', 'RECENT-ONE']);
});

// Last: drops the table.
test('a venue database without the NoTicketOrder table still processes sales (as before the migration)', async (t) => {
  await ctx.pgClient.query(`DROP TABLE "NoTicketOrder"`);
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  squareHandlers.batchRetrieveCatalog = concessionCatalog;
  await handler(buildSqsEvent([record('ORDER-SODA-2'), record('ORDER-SODA-2')]));
  assert.equal(orderFetches, 2, 'no guard without the table: processed each time, like before');
  squareHandlers.batchRetrieveCatalog = ticketCatalog;
  await handler(buildSqsEvent([record('ORDER-TICKET-2')]));
  assert.equal(await count('QRCodeProduct'), 1);
  assert.deepEqual(errors.filter((e) => e.includes('NoTicketOrder')), [], 'a missing table is expected, not logged as an error');
});
