import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, smsHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({
    clientConfig: {
      SEND_SMS: 'true',
      SMS_ORIGINATION_NUMBER: '+15559998888',
      SMS_SENDER_BRAND: 'TestVenue',
      STATIC_WEBSITE_URL: 'https://example.com'
    }
  });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "SmsConsent"`);
  await ctx.pgClient.query(`DELETE FROM "SmsOutboundLog"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProductToOrder"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
  await ctx.pgClient.query(`DELETE FROM "Order"`);
  await ctx.pgClient.query(`DELETE FROM "Customer"`);
});

async function insertOrderWithToken({ optInToken = 'TOKEN1', phoneNumber = null, qrCode = 'QR-OPTIN-1' } = {}) {
  const orderResult = await ctx.pgClient.query(
    `INSERT INTO "Order" ("OrderID", "OptInToken", "PhoneNumber", "FirstName", "LastName", "EmailAddress")
     VALUES ($1, $2, $3, 'Jane', 'Doe', 'jane@example.com') RETURNING "ID"`,
    [`ORDER-${optInToken}`, optInToken, phoneNumber]
  );
  const ticketResult = await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', 'Movie Night', 'Main', 'Movie', 'details', 'ITEM')
     RETURNING "ID"`,
    [qrCode]
  );
  await ctx.pgClient.query(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`, [ticketResult.rows[0].ID, orderResult.rows[0].ID]);
  return orderResult.rows[0].ID;
}

// ---- GET /api/public/opt-in ----

test('GET /api/public/opt-in: a fresh order with no prior consent reports consentState "new"', async () => {
  await insertOrderWithToken({ optInToken: 'TOKENNEW' });
  const { status, json } = await ctx.request('GET', `/api/public/opt-in?token=TOKENNEW&client=${ctx.clientId}`);
  assert.equal(status, 200);
  assert.equal(json.orderExists, true);
  assert.equal(json.consentState, 'new');
  assert.equal(json.tickets.length, 1);
});

test('GET /api/public/opt-in: an order with active consent reports "active", masked phone, and auto-resends', async () => {
  const customer = await ctx.pgClient.query(`INSERT INTO "Customer" ("PhoneNumber") VALUES ('+15551234567') RETURNING "ID"`);
  await ctx.pgClient.query(`INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText") VALUES ($1, '+15551234567', 'active', 'web_initial', 'I agree')`, [customer.rows[0].ID]);
  await insertOrderWithToken({ optInToken: 'TOKENACTIVE', phoneNumber: '+15551234567' });

  const { status, json } = await ctx.request('GET', `/api/public/opt-in?token=TOKENACTIVE&client=${ctx.clientId}`);
  assert.equal(status, 200);
  assert.equal(json.consentState, 'active');
  assert.match(json.phoneMasked, /xxx/);

  const log = await ctx.pgClient.query(`SELECT * FROM "SmsOutboundLog"`);
  assert.equal(log.rows.length, 1, 'active consent should auto-resend the ticket SMS');
});

test('GET /api/public/opt-in: an order with revoked consent reports "revoked" with an unsubscribe date', async () => {
  const customer = await ctx.pgClient.query(`INSERT INTO "Customer" ("PhoneNumber") VALUES ('+15551234568') RETURNING "ID"`);
  await ctx.pgClient.query(`INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText", "RevokedAt") VALUES ($1, '+15551234568', 'revoked', 'web_initial', 'I agree', NOW())`, [customer.rows[0].ID]);
  await insertOrderWithToken({ optInToken: 'TOKENREVOKED', phoneNumber: '+15551234568' });

  const { json } = await ctx.request('GET', `/api/public/opt-in?token=TOKENREVOKED&client=${ctx.clientId}`);
  assert.equal(json.consentState, 'revoked');
  assert.ok(json.previousUnsubscribeDate);
});

test('GET /api/public/opt-in: an unknown token returns 404', async () => {
  const { status, json } = await ctx.request('GET', `/api/public/opt-in?token=NOPETOKEN&client=${ctx.clientId}`);
  assert.equal(status, 404);
  assert.equal(json.success, false);
});

test('GET /api/public/opt-in: missing token or client is a 400', async () => {
  const r1 = await ctx.request('GET', `/api/public/opt-in?client=${ctx.clientId}`);
  assert.equal(r1.status, 400);
  const r2 = await ctx.request('GET', '/api/public/opt-in?token=TOKENX');
  assert.equal(r2.status, 400);
});

test('GET /api/public/opt-in: a malformed token (not base64url, or too long) is rejected before touching the DB', async () => {
  const r1 = await ctx.request('GET', `/api/public/opt-in?token=${encodeURIComponent('bad token!')}&client=${ctx.clientId}`);
  assert.equal(r1.status, 400);
  const r2 = await ctx.request('GET', `/api/public/opt-in?token=${'a'.repeat(40)}&client=${ctx.clientId}`);
  assert.equal(r2.status, 400);
});

test('GET /api/public/opt-in: a malformed clientId is rejected before attempting any DB connection', async () => {
  const { status } = await ctx.request('GET', '/api/public/opt-in?token=TOKENX&client=not-alphanumeric!');
  assert.equal(status, 400);
});

// ---- POST /api/public/opt-in ----

test('POST /api/public/opt-in: a brand new opt-in inserts consent, upserts Customer, and sends SMS', async () => {
  await insertOrderWithToken({ optInToken: 'TOKENPOST1' });
  let sentBody;
  smsHandlers.sendTextMessage = async (input) => { sentBody = input; return { MessageId: 'mock-id-1' }; };

  const { status, json } = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENPOST1', clientId: ctx.clientId, phone: '5551112222', consentText: 'I agree to receive texts' }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.ticketsSent, 1);
  assert.ok(sentBody);
  assert.equal(sentBody.DestinationPhoneNumber, '+15551112222');

  const consent = await ctx.pgClient.query(`SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = '+15551112222'`);
  assert.equal(consent.rows.length, 1);
  assert.equal(consent.rows[0].Status, 'active');
  assert.equal(consent.rows[0].OptInMethod, 'web_initial');

  const customer = await ctx.pgClient.query(`SELECT * FROM "Customer" WHERE "PhoneNumber" = '+15551112222'`);
  assert.equal(customer.rows.length, 1);
});

test('POST /api/public/opt-in: resubscribing after a revoke links PreviousConsentID and uses web_resubscribe', async () => {
  const customer = await ctx.pgClient.query(`INSERT INTO "Customer" ("PhoneNumber") VALUES ('+15551112223') RETURNING "ID"`);
  const revoked = await ctx.pgClient.query(
    `INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText", "RevokedAt") VALUES ($1, '+15551112223', 'revoked', 'web_initial', 'old', NOW()) RETURNING "ID"`,
    [customer.rows[0].ID]
  );
  await insertOrderWithToken({ optInToken: 'TOKENRESUB' });

  const { status, json } = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENRESUB', clientId: ctx.clientId, phone: '5551112223', consentText: 'I agree again' }
  });
  assert.equal(status, 200);
  assert.equal(json.resubscribe, true);

  const newConsent = await ctx.pgClient.query(`SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = '+15551112223' AND "Status" = 'active'`);
  assert.equal(newConsent.rows.length, 1);
  assert.equal(newConsent.rows[0].OptInMethod, 'web_resubscribe');
  assert.equal(newConsent.rows[0].PreviousConsentID, revoked.rows[0].ID);
});

test('POST /api/public/opt-in: an already-active phone is an idempotent re-send, no duplicate SmsConsent row', async () => {
  const customer = await ctx.pgClient.query(`INSERT INTO "Customer" ("PhoneNumber") VALUES ('+15551112224') RETURNING "ID"`);
  await ctx.pgClient.query(`INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText") VALUES ($1, '+15551112224', 'active', 'web_initial', 'already in')`, [customer.rows[0].ID]);
  await insertOrderWithToken({ optInToken: 'TOKENIDEMPOTENT' });

  const { status, json } = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENIDEMPOTENT', clientId: ctx.clientId, phone: '5551112224', consentText: 'I agree' }
  });
  assert.equal(status, 200);
  assert.equal(json.idempotent, true);

  const consents = await ctx.pgClient.query(`SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = '+15551112224'`);
  assert.equal(consents.rows.length, 1, 'no new row should have been inserted');
});

test('POST /api/public/opt-in: a token already claimed by a different phone is rejected with 409', async () => {
  await insertOrderWithToken({ optInToken: 'TOKENCLAIMED' });
  const first = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENCLAIMED', clientId: ctx.clientId, phone: '5551112225', consentText: 'first claim' }
  });
  assert.equal(first.status, 200);

  const second = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENCLAIMED', clientId: ctx.clientId, phone: '5559998888', consentText: 'second claim attempt' }
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.success, false);
});

test('POST /api/public/opt-in: the SAME phone re-submitting the same token is allowed (idempotent claim)', async () => {
  await insertOrderWithToken({ optInToken: 'TOKENSAMECLAIM' });
  const first = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENSAMECLAIM', clientId: ctx.clientId, phone: '5551112226', consentText: 'first' }
  });
  assert.equal(first.status, 200);

  const second = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENSAMECLAIM', clientId: ctx.clientId, phone: '5551112226', consentText: 'second' }
  });
  assert.equal(second.status, 200);
});

test('POST /api/public/opt-in: an invalid phone number is rejected with 400', async () => {
  await insertOrderWithToken({ optInToken: 'TOKENBADPHONE' });
  const { status, json } = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENBADPHONE', clientId: ctx.clientId, phone: '123', consentText: 'I agree' }
  });
  assert.equal(status, 400);
  assert.match(json.message, /valid/);
});

test('POST /api/public/opt-in: missing required fields rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/public/opt-in', { body: { token: 'X', clientId: ctx.clientId } });
  assert.equal(status, 400);
});

test('POST /api/public/opt-in: an unknown token returns 404', async () => {
  const { status } = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'NOSUCHTOKEN', clientId: ctx.clientId, phone: '5551112227', consentText: 'I agree' }
  });
  assert.equal(status, 404);
});

test('POST /api/public/opt-in: consent text over 1000 chars is rejected with 400', async () => {
  await insertOrderWithToken({ optInToken: 'TOKENLONGTEXT' });
  const { status } = await ctx.request('POST', '/api/public/opt-in', {
    body: { token: 'TOKENLONGTEXT', clientId: ctx.clientId, phone: '5551112228', consentText: 'x'.repeat(1001) }
  });
  assert.equal(status, 400);
});
