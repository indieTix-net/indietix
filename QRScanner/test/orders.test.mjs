import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, sesHandlers, s3Handlers, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
});

async function insertOrderWithTicket({
  orderId = 'ORDER-1', status = 'Valid', emailAddress = 'buyer@example.com',
  qrCode = 'QR-ORD-1', ticketStatus = 'valid', orderMetaData = {}
} = {}) {
  const orderResult = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID", "EmailAddress", "FirstName", "LastName", "Status", "OrderMetaData")
     VALUES ($1, $2, 'Jane', 'Doe', $3, $4) RETURNING "ID"`,
    [orderId, emailAddress, status, JSON.stringify(orderMetaData)]
  );
  const dbOrderId = orderResult.rows[0].ID;

  const ticketResult = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', 'Movie', 'Main', 'Movie', 'details', 'ITEM', $2)
     RETURNING "ID"`,
    [qrCode, ticketStatus]
  );
  const ticketId = ticketResult.rows[0].ID;

  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`,
    [ticketId, dbOrderId]
  );

  return { dbOrderId, ticketId };
}

// ---- resend-email ----

test('POST /api/orders/:orderId/resend-email: resends the ticket email with attachments', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-RESEND', emailAddress: 'resend@example.com' });
  let captured;
  sesHandlers.sendRawEmail = async (params) => { captured = params; return { MessageId: 'mock-id' }; };
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/resend-email`, { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.emailAddress, 'resend@example.com');
  assert.equal(json.qrCodesAttached, 1);
  assert.ok(captured);
});

test('POST /api/orders/:orderId/resend-email: a nonexistent order returns 404', async () => {
  const { status, json } = await ctx.request('POST', '/api/orders/999999/resend-email', { token: ctx.clientToken });
  assert.equal(status, 404);
  assert.equal(json.returnStatus, 'failed_no_order');
});

test('POST /api/orders/:orderId/resend-email: an order with no linked tickets returns 404', async () => {
  const result = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID", "EmailAddress") VALUES ('ORDER-NO-TIX', 'x@example.com') RETURNING "ID"`
  );
  const { status, json } = await ctx.request('POST', `/api/orders/${result.rows[0].ID}/resend-email`, { token: ctx.clientToken });
  assert.equal(status, 404);
  assert.equal(json.returnStatus, 'failed_no_qrcodes');
});

test('POST /api/orders/:orderId/resend-email: an invalid email address on the order is rejected', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-BADEMAIL', emailAddress: 'not-an-email' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/resend-email`, { token: ctx.clientToken });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_invalid_email');
});

test('POST /api/orders/:orderId/resend-email: an S3 fetch failure for every ticket surfaces as a 500', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-S3FAIL' });
  s3Handlers.getObject = async () => { throw new Error('mock S3 failure'); };
  const { status } = await ctx.request('POST', `/api/orders/${dbOrderId}/resend-email`, { token: ctx.clientToken });
  assert.equal(status, 500);
});

// ---- edit ----

test('PUT /api/orders/:orderId/edit: updates order and linked ticket contact info atomically', async () => {
  const { dbOrderId, ticketId } = await insertOrderWithTicket({ orderId: 'ORDER-EDIT' });
  const { status, json } = await ctx.request('PUT', `/api/orders/${dbOrderId}/edit`, {
    token: ctx.clientToken,
    body: { firstName: 'New', lastName: 'Name', phoneNumber: '+15551234567', emailAddress: 'new@example.com' }
  });
  assert.equal(status, 200);
  assert.equal(json.ordersUpdated, 1);
  assert.equal(json.qrCodesUpdated, 1);
  const ticket = await ctx.pgClient.query(`SELECT "EmailAddress" FROM "QRCodeProduct" WHERE "ID" = $1`, [ticketId]);
  assert.equal(ticket.rows[0].EmailAddress, 'new@example.com');
});

test('PUT /api/orders/:orderId/edit: an invalid email is rejected with 400', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-EDIT-BAD' });
  const { status } = await ctx.request('PUT', `/api/orders/${dbOrderId}/edit`, { token: ctx.clientToken, body: { emailAddress: 'nope' } });
  assert.equal(status, 400);
});

test('PUT /api/orders/:orderId/edit: a nonexistent order returns 404', async () => {
  const { status } = await ctx.request('PUT', '/api/orders/999999/edit', { token: ctx.clientToken, body: { emailAddress: 'x@example.com' } });
  assert.equal(status, 404);
});

// ---- tickets ----

test('GET /api/orders/:orderId/tickets: lists tickets linked to the order', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-TIX', qrCode: 'QR-TIX-LIST' });
  const { status, json } = await ctx.request('GET', `/api/orders/${dbOrderId}/tickets`, { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.tickets.length, 1);
  assert.equal(json.tickets[0].QRCode, 'QR-TIX-LIST');
});

test('GET /api/orders/:orderId/tickets: an order with no tickets returns an empty list, not an error', async () => {
  const result = await ctx.pgClient.query(`INSERT INTO "Order" ("OrderID") VALUES ('ORDER-EMPTY') RETURNING "ID"`);
  const { status, json } = await ctx.request('GET', `/api/orders/${result.rows[0].ID}/tickets`, { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json.tickets, []);
});

// ---- order-level refund (Square-backed) ----

function refundBody(overrides = {}) {
  return { paymentId: 'sq-payment-1', refundedBy: 'staff1', refundReason: 'customer request', ...overrides };
}

test('POST /api/orders/:orderId/refund: full refund invalidates all valid tickets and records audit metadata', async () => {
  const { dbOrderId, ticketId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-1' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: refundBody() });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.ticketsInvalidated, 1);
  assert.equal(json.partial, false);
  const ticket = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" WHERE "ID" = $1`, [ticketId]);
  assert.equal(ticket.rows[0].Status, 'refunded');
  const order = await ctx.pgClient.query(`SELECT "Status" FROM "Order" WHERE "ID" = $1`, [dbOrderId]);
  assert.equal(order.rows[0].Status, 'Refunded');
});

test('POST /api/orders/:orderId/refund: missing paymentId/refundedBy/refundReason are each rejected with 400', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-VALIDATE' });
  const r1 = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: { refundedBy: 'x', refundReason: 'y' } });
  assert.equal(r1.status, 400);
  const r2 = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: { paymentId: 'x', refundReason: 'y' } });
  assert.equal(r2.status, 400);
  const r3 = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: { paymentId: 'x', refundedBy: 'y' } });
  assert.equal(r3.status, 400);
});

test('POST /api/orders/:orderId/refund: an order already fully refunded is rejected', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-DUP', ticketStatus: 'refunded' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: refundBody() });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_already_refunded');
});

test('POST /api/orders/:orderId/refund: a requested amount exceeding the real Square payment amount is rejected', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-OVER' });
  squareHandlers.getPayment = async (id) => ({ ok: true, status: 200, json: async () => ({ payment: { id, status: 'COMPLETED', amount_money: { amount: 500, currency: 'USD' }, refund_ids: [] } }) });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: refundBody({ refundAmount: 1000 }) });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_amount_exceeds_payment');
});

test('POST /api/orders/:orderId/refund: a payment that already has a Square-side refund is rejected', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-EXISTING' });
  squareHandlers.getPayment = async (id) => ({ ok: true, status: 200, json: async () => ({ payment: { id, status: 'COMPLETED', amount_money: { amount: 1000, currency: 'USD' }, refund_ids: ['existing-refund'] } }) });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: refundBody() });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_already_has_refunds');
});

test('POST /api/orders/:orderId/refund: a non-refundable payment status is rejected', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-STATUS' });
  squareHandlers.getPayment = async (id) => ({ ok: true, status: 200, json: async () => ({ payment: { id, status: 'FAILED', amount_money: { amount: 1000, currency: 'USD' }, refund_ids: [] } }) });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: refundBody() });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_payment_not_refundable');
});

test('POST /api/orders/:orderId/refund: a Square API refund-call failure is surfaced, not swallowed', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-SQFAIL' });
  squareHandlers.createRefund = async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ detail: 'mock square refund failure' }] }) });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, { token: ctx.clientToken, body: refundBody() });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_square_api');
});

test('POST /api/orders/:orderId/refund: ticketIds referencing another order are rejected (cross-order isolation)', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-ISO-A', qrCode: 'QR-ISO-A' });
  const { ticketId: foreignTicketId } = await insertOrderWithTicket({ orderId: 'ORDER-REFUND-ISO-B', qrCode: 'QR-ISO-B' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/refund`, {
    token: ctx.clientToken, body: refundBody({ ticketIds: [foreignTicketId] })
  });
  assert.equal(status, 400);
  assert.equal(json.returnStatus, 'failed_invalid_ticket_ids');
});

// ---- cancel ----

test('POST /api/orders/:orderId/cancel: cancels a valid order and invalidates its tickets', async () => {
  const { dbOrderId, ticketId } = await insertOrderWithTicket({ orderId: 'ORDER-CANCEL-1' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/cancel`, {
    token: ctx.clientToken, body: { cancelledBy: 'staff1', cancelReason: 'duplicate order' }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const ticket = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" WHERE "ID" = $1`, [ticketId]);
  assert.equal(ticket.rows[0].Status, 'cancelled');
});

test('POST /api/orders/:orderId/cancel: missing cancelledBy/cancelReason rejected with 400', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-CANCEL-VALIDATE' });
  const { status } = await ctx.request('POST', `/api/orders/${dbOrderId}/cancel`, { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
});

test('POST /api/orders/:orderId/cancel: an already-cancelled order cannot be cancelled again', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-CANCEL-DUP', status: 'Cancelled' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/cancel`, {
    token: ctx.clientToken, body: { cancelledBy: 'staff1', cancelReason: 'x' }
  });
  assert.equal(status, 400);
  assert.match(json.message, /Cancelled/);
});

// ---- delete ----

test('POST /api/orders/:orderId/delete: deletes a valid order and invalidates its tickets', async () => {
  const { dbOrderId, ticketId } = await insertOrderWithTicket({ orderId: 'ORDER-DELETE-1' });
  const { status, json } = await ctx.request('POST', `/api/orders/${dbOrderId}/delete`, {
    token: ctx.clientToken, body: { deletedBy: 'staff1', deleteReason: 'test order' }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const ticket = await ctx.pgClient.query(`SELECT "Status" FROM "QRCodeProduct" WHERE "ID" = $1`, [ticketId]);
  assert.equal(ticket.rows[0].Status, 'deleted');
});

test('POST /api/orders/:orderId/delete: missing deletedBy/deleteReason rejected with 400', async () => {
  const { dbOrderId } = await insertOrderWithTicket({ orderId: 'ORDER-DELETE-VALIDATE' });
  const { status } = await ctx.request('POST', `/api/orders/${dbOrderId}/delete`, { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
});

test('POST /api/orders/:orderId/delete: a nonexistent order returns 404', async () => {
  const { status } = await ctx.request('POST', '/api/orders/999999/delete', {
    token: ctx.clientToken, body: { deletedBy: 'staff1', deleteReason: 'x' }
  });
  assert.equal(status, 404);
});
