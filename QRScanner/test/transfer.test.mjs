import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { startTestServer, stopTestServer, s3Handlers, sesHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

async function blankTemplate(width = 1800, height = 600) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);

  // The transfer route fetches the horizontal template from S3 by default
  // (globalConfig.TICKET_FILENAME || 'ticket_horizontal.pdf') -- serve a
  // real blank PDF for that specific key, mock bytes for anything else.
  const templateBuffer = await blankTemplate(1800, 600);
  s3Handlers.getObject = async (params) => {
    if (params.Key === 'ticket_horizontal.pdf') return { Body: templateBuffer };
    return { Body: Buffer.from('mock-s3-object-body') };
  };
});

async function insertTransferableTicket({ qrCode = 'QR-XFER-1', orderId = 'ORDER-XFER-1', status = 'valid', checkedIn = false } = {}) {
  const orderResult = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID") VALUES ($1) RETURNING "ID"`,
    [orderId]
  );
  const ticketResult = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductSeatCode", "ProductID", "Status", "CheckedIn")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', 'Movie Night', 'Main', 'Movie', 'Adult', 'A12', 'ITEM', $2, $3)
     RETURNING "ID"`,
    [qrCode, status, checkedIn]
  );
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`,
    [ticketResult.rows[0].ID, orderResult.rows[0].ID]
  );
  return ticketResult.rows[0].ID;
}

test('POST /api/products/:id/transfer: transfers a valid, not-checked-in ticket to a new recipient', async () => {
  const id = await insertTransferableTicket({ qrCode: 'QR-XFER-OK' });
  let emailedTo;
  sesHandlers.sendRawEmail = async () => { emailedTo = true; return { MessageId: 'mock-id' }; };

  const { status, json } = await ctx.request('POST', `/api/products/${id}/transfer`, {
    token: ctx.clientToken,
    body: { recipientFirstName: 'New', recipientLastName: 'Owner', recipientEmail: 'recipient@example.com' }
  });

  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'successful_transfer');
  assert.ok(json.newQrCode.startsWith('TRANSFER-'));
  assert.ok(emailedTo);

  const original = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" WHERE "ID" = $1`, [id]);
  assert.equal(original.rows[0].Status, 'transferred');

  const newTicket = await ctx.pgClient.query(`SELECT * FROM "QRCodeProduct" WHERE "QRCode" = $1`, [json.newQrCode]);
  assert.equal(newTicket.rows.length, 1);
  assert.equal(newTicket.rows[0].Status, 'valid');
  assert.equal(newTicket.rows[0].EmailAddress, 'recipient@example.com');

  const link = await ctx.pgClient.query(
    `SELECT pto."OrderID" FROM "QRCodeProductToOrder" pto WHERE pto."QRCodeProductID" = $1`,
    [newTicket.rows[0].ID]
  );
  assert.equal(link.rows.length, 1, 'the new ticket must carry the same order link forward');
});

test('POST /api/products/:id/transfer: missing/invalid recipient email is rejected with 400, nothing touched', async () => {
  const id = await insertTransferableTicket({ qrCode: 'QR-XFER-BADEMAIL' });
  const { status, json } = await ctx.request('POST', `/api/products/${id}/transfer`, {
    token: ctx.clientToken, body: { recipientEmail: 'not-an-email' }
  });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_validation');
});

test('POST /api/products/:id/transfer: a nonexistent ticket returns 404', async () => {
  const { status, json } = await ctx.request('POST', '/api/products/999999/transfer', {
    token: ctx.clientToken, body: { recipientEmail: 'recipient@example.com' }
  });
  assert.equal(status, 404);
  assert.equal(json.returnStatus, 'failed_no_product');
});

test('POST /api/products/:id/transfer: a non-valid ticket (already refunded) cannot be transferred', async () => {
  const id = await insertTransferableTicket({ qrCode: 'QR-XFER-REFUNDED', status: 'refunded' });
  const { status, json } = await ctx.request('POST', `/api/products/${id}/transfer`, {
    token: ctx.clientToken, body: { recipientEmail: 'recipient@example.com' }
  });
  assert.equal(status, 409);
  assert.equal(json.returnStatus, 'failed_not_transferable');
});

test('POST /api/products/:id/transfer: an already-checked-in ticket cannot be transferred', async () => {
  const id = await insertTransferableTicket({ qrCode: 'QR-XFER-CHECKEDIN', checkedIn: true });
  const { status, json } = await ctx.request('POST', `/api/products/${id}/transfer`, {
    token: ctx.clientToken, body: { recipientEmail: 'recipient@example.com' }
  });
  assert.equal(status, 409);
  assert.equal(json.returnStatus, 'failed_already_checked_in');
});

test('POST /api/products/:id/transfer: original ticket is left untouched if PDF template fetch fails', async () => {
  const id = await insertTransferableTicket({ qrCode: 'QR-XFER-S3FAIL' });
  s3Handlers.getObject = async () => { throw new Error('mock template fetch failure'); };
  const { status } = await ctx.request('POST', `/api/products/${id}/transfer`, {
    token: ctx.clientToken, body: { recipientEmail: 'recipient@example.com' }
  });
  assert.equal(status, 500);
  const original = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" WHERE "ID" = $1`, [id]);
  assert.equal(original.rows[0].Status, 'valid', 'a failed render must not have mutated the original ticket');
});

test('POST /api/products/:id/transfer: succeeds (ticket still transferred) even if the recipient email fails to send', async () => {
  const id = await insertTransferableTicket({ qrCode: 'QR-XFER-EMAILFAIL' });
  sesHandlers.sendRawEmail = async () => { throw new Error('mock SES failure'); };
  const { status, json } = await ctx.request('POST', `/api/products/${id}/transfer`, {
    token: ctx.clientToken, body: { recipientEmail: 'recipient@example.com' }
  });
  assert.equal(status, 200);
  assert.equal(json.returnStatus, 'successful_transfer_email_failed');
  const original = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" WHERE "ID" = $1`, [id]);
  assert.equal(original.rows[0].Status, 'transferred');
});
