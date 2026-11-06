import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';
import { scrubPersonalJson, normalizeSubject } from '../src/utils/privacy-requests.mjs';

// Customer privacy requests (PRIVACY REQUESTS in app.mjs,
// utils/privacy-requests.mjs): search, export and redact one person's data.
// Redaction replaces personal details but keeps every record.

let ctx;
before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

const q = (sql, params) => ctx.pgClient.query(sql, params);
const post = (path, body, token = ctx.clientToken) => ctx.request('POST', path, { token, body });
const VERIFY = { verification: 'Replied from the email on the order', receivedDate: '2026-11-06' };

let ids;
beforeEach(async () => {
  await q(`TRUNCATE "Order", "QRCodeProduct", "QRCodeProductToOrder", "Customer", "SmsConsent", "SmsOutboundLog", "MarketingEmailContact", "ApiIdempotency", "PrivacyRequest" RESTART IDENTITY`);
  const meta = {
    order: {
      id: 'SQ-ORDER-1', ticket_name: 'Jane at the bar',
      fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Jane Doe', email_address: 'jane@example.com', phone_number: '+17855551234' } } }],
      tenders: [{ type: 'CARD', card_details: { card: { card_brand: 'VISA', last_4: '4242', cardholder_name: 'JANE DOE', fingerprint: 'sq-fp-1' } } }],
      line_items: [{ name: 'Test Movie', note: 'for Jane', quantity: '2' }],
      total_money: { amount: 2000, currency: 'USD' }
    }
  };
  const order = await q(
    `INSERT INTO "Order" ("OrderID", "FirstName", "LastName", "EmailAddress", "PhoneNumber", "Status", "OrderMetaData", "OptInToken", "OptInClaimedByPhone")
     VALUES ('SQ-ORDER-1', 'Jane', 'Doe', 'Jane@Example.com', '(785) 555-1234', 'Valid', $1, 'tok123', '+17855551234') RETURNING "ID"`,
    [JSON.stringify(meta)]);
  const other = await q(
    `INSERT INTO "Order" ("OrderID", "FirstName", "LastName", "EmailAddress", "PhoneNumber", "Status", "OrderMetaData")
     VALUES ('SQ-ORDER-2', 'Sam', 'Smith', 'sam@example.com', '+17855559999', 'Valid', '{"order":{"id":"SQ-ORDER-2"}}') RETURNING "ID"`);
  const ticket = (code, first, email, phone) => q(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status", "FirstName", "LastName", "EmailAddress", "PhoneNumber", "ProductPrice", "ProductMetadata")
     VALUES ($1, '2099-01-01', '2099-01-01 19:00:00', 'Test Movie', 'LOC', 'Movie', 'details', 'ITEM', 'valid', $2, 'Doe', $3, $4, 10, '{"name":"Test Movie","note":"for Jane"}') RETURNING "ID"`,
    [code, first, email, phone]);
  const t1 = await ticket('QR-JANE-1', 'Jane', 'jane@example.com', '+17855551234');
  const t2 = await ticket('QR-JANE-2', null, null, null); // on her order, no details of its own
  const t3 = await ticket('QR-SAM-1', 'Sam', 'sam@example.com', '+17855559999');
  await q(`INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $3), ($2, $3), ($4, $5)`,
    [t1.rows[0].ID, t2.rows[0].ID, order.rows[0].ID, t3.rows[0].ID, other.rows[0].ID]);
  const customer = await q(`INSERT INTO "Customer" ("PhoneNumber", "Email", "FirstName", "LastName") VALUES ('+17855551234', 'jane@example.com', 'Jane', 'Doe') RETURNING "ID"`);
  await q(`INSERT INTO "SmsConsent" ("CustomerID", "PhoneNumber", "Status", "OptInMethod", "ConsentText", "IPAddress", "UserAgent") VALUES ($1, '+17855551234', 'active', 'web_initial', 'I agree', '203.0.113.5', 'Mozilla')`, [customer.rows[0].ID]);
  await q(`INSERT INTO "SmsOutboundLog" ("PhoneNumber", "MessageID", "BodyPreview") VALUES ('+17855551234', 'm1', 'Your tickets for Test Movie')`);
  await q(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('jane@example.com', 'active', 'unsub-jane'), ('sam@example.com', 'active', 'unsub-sam')`);
  await q(`INSERT INTO "ApiIdempotency" ("ApiKeyID", "IdempotencyKey", "ResponseStatus", "ResponseBody") VALUES (1, 'k1', 200, '{"email":"jane@example.com"}'), (1, 'k2', 200, '{"email":"sam@example.com"}')`);
  ids = { order: order.rows[0].ID, other: other.rows[0].ID, customer: customer.rows[0].ID };
});

test('scrubPersonalJson: replaces personal fields at any depth, keeps the rest', () => {
  const scrubbed = scrubPersonalJson({ a: { recipient: { email_address: 'x' }, total_money: { amount: 5 } }, list: [{ cardholder_name: 'X', card_brand: 'VISA', last_4: '1' }], name: 'Movie' });
  assert.deepEqual(scrubbed, { a: { recipient: 'REDACTED', total_money: { amount: 5 } }, list: [{ cardholder_name: 'REDACTED', card_brand: 'VISA', last_4: 'REDACTED' }], name: 'Movie' });
});

test('normalizeSubject: needs a valid email or phone', () => {
  assert.ok(normalizeSubject({}).error);
  assert.ok(normalizeSubject({ email: 'nope' }).error);
  assert.deepEqual(normalizeSubject({ email: ' Jane@Example.com ', phone: '785-555-1234' }), { email: 'jane@example.com', phone: '+17855551234', last10: '7855551234' });
});

test('POST /api/privacy/search: finds everything about the person by email or phone, nothing about others', async () => {
  for (const body of [{ email: 'JANE@example.com' }, { phone: '785.555.1234' }]) {
    const { status, json } = await post('/api/privacy/search', body);
    assert.equal(status, 200);
    assert.deepEqual(json.counts, { orders: 1, tickets: 2, customers: 1, consents: 1, texts: 1, emailContacts: body.email ? 1 : 0, apiReplays: body.email ? 1 : 0 });
    assert.equal(json.orders[0].orderId, 'SQ-ORDER-1');
    assert.equal(json.textConsent[0].status, 'active');
  }
  assert.equal((await post('/api/privacy/search', {})).status, 400);
  // Searching logs nothing
  assert.equal((await q(`SELECT COUNT(*)::int AS n FROM "PrivacyRequest"`)).rows[0].n, 0);
});

test('POST /api/privacy/export: returns their data without link tokens, and logs the request without their email', async () => {
  assert.equal((await post('/api/privacy/export', { email: 'jane@example.com' })).status, 400, 'verification is required');
  const { status, json } = await post('/api/privacy/export', { email: 'jane@example.com', ...VERIFY });
  assert.equal(status, 200);
  assert.equal(json.data.orders.length, 1);
  assert.equal(json.data.tickets.length, 2);
  assert.equal(json.data.orders[0].OptInToken, undefined);
  assert.equal(json.data.emailList[0].UnsubscribeToken, undefined);
  const log = (await q(`SELECT * FROM "PrivacyRequest"`)).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].RequestType, 'export');
  assert.equal(log[0].ReceivedDate.toISOString().slice(0, 10), '2026-11-06');
  assert.match(log[0].SubjectFingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(log), /jane|5551234/i);
});

test('POST /api/privacy/redact: replaces personal details, keeps every record, leaves others alone', async () => {
  assert.equal((await post('/api/privacy/redact', { email: 'jane@example.com', ...VERIFY })).status, 400, 'needs confirm');
  const { status, json } = await post('/api/privacy/redact', { email: 'jane@example.com', phone: '7855551234', ...VERIFY, confirm: true });
  assert.equal(status, 200);
  assert.equal(json.redacted.orders, 1);
  assert.equal(json.redacted.consentsRevoked, 1);

  const order = (await q(`SELECT * FROM "Order" WHERE "ID" = $1`, [ids.order])).rows[0];
  assert.equal(order.FirstName, 'Redacted');
  assert.equal(order.LastName, null);
  assert.equal(order.EmailAddress, null);
  assert.equal(order.PhoneNumber, null);
  assert.equal(order.OptInToken, null);
  assert.equal(order.Status, 'Valid');
  assert.equal(order.OrderMetaData.order.total_money.amount, 2000, 'amounts kept');
  assert.equal(order.OrderMetaData.order.fulfillments[0].pickup_details.recipient, 'REDACTED');
  assert.equal(order.OrderMetaData.order.tenders[0].card_details.card.cardholder_name, 'REDACTED');
  assert.equal(order.OrderMetaData.order.tenders[0].card_details.card.card_brand, 'VISA');
  assert.equal(order.OrderMetaData.order.ticket_name, 'REDACTED');
  assert.ok(order.OrderMetaData.privacyRedaction.redactedAt);
  assert.doesNotMatch(JSON.stringify(order), /jane|5551234/i);

  const tickets = (await q(`SELECT * FROM "QRCodeProduct" ORDER BY "ID"`)).rows;
  assert.equal(tickets.length, 3, 'no ticket removed');
  for (const t of tickets.slice(0, 2)) {
    assert.equal(t.Status, 'valid', 'tickets still work');
    assert.match(t.QRCode, /^QR-JANE-/);
    assert.equal(t.EmailAddress, null);
    assert.doesNotMatch(JSON.stringify({ ...t, QRCode: undefined }), /jane|5551234/i);
  }
  assert.equal(tickets[2].FirstName, 'Sam', 'someone else untouched');
  assert.equal((await q(`SELECT "EmailAddress" FROM "Order" WHERE "ID" = $1`, [ids.other])).rows[0].EmailAddress, 'sam@example.com');

  const customer = (await q(`SELECT * FROM "Customer" WHERE "ID" = $1`, [ids.customer])).rows[0];
  assert.match(customer.PhoneNumber, /^R[0-9a-f]{15}$/);
  assert.equal(customer.Email, null);

  // Consent kept as proof, but revoked
  const consent = (await q(`SELECT * FROM "SmsConsent"`)).rows[0];
  assert.equal(consent.PhoneNumber, '+17855551234');
  assert.equal(consent.Status, 'revoked');
  assert.ok(consent.RevokedAt);

  const text = (await q(`SELECT * FROM "SmsOutboundLog"`)).rows[0];
  assert.match(text.PhoneNumber, /^R[0-9a-f]{15}$/);
  assert.equal(text.BodyPreview, null);

  const contacts = (await q(`SELECT * FROM "MarketingEmailContact" ORDER BY "ID"`)).rows;
  assert.match(contacts[0].Email, /^redacted-[0-9a-f]{16}@redacted\.invalid$/);
  assert.equal(contacts[0].Status, 'unsubscribed');
  assert.equal(contacts[1].Email, 'sam@example.com');

  assert.deepEqual((await q(`SELECT "IdempotencyKey" FROM "ApiIdempotency"`)).rows.map(r => r.IdempotencyKey), ['k2']);

  const log = (await q(`SELECT * FROM "PrivacyRequest"`)).rows;
  assert.equal(log[0].RequestType, 'redact');
  assert.equal(log[0].Matches.orders, 1);

  // Running it again finds nothing left to redact
  const again = await post('/api/privacy/redact', { email: 'jane@example.com', ...VERIFY, confirm: true });
  assert.equal(again.status, 404);
});

test('GET /api/privacy/requests: lists the log', async () => {
  await post('/api/privacy/export', { email: 'jane@example.com', ...VERIFY });
  const { status, json } = await ctx.request('GET', '/api/privacy/requests', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.requests.length, 1);
  assert.equal(json.requests[0].RequestType, 'export');
  assert.equal(json.requests[0].ReceivedDate, '2026-11-06');
});

test('privacy routes are for the main venue login only', async () => {
  const staff = await ctx.insertUser({ username: `staff${Date.now()}`, permissions: { view: true, edit: true, checkIn: true, marketing: true, admin: true } });
  for (const path of ['/api/privacy/search', '/api/privacy/export', '/api/privacy/redact']) {
    assert.equal((await post(path, { email: 'jane@example.com', ...VERIFY, confirm: true }, staff.token)).status, 403, path);
    assert.equal((await post(path, { email: 'jane@example.com' }, null)).status, 401, path);
  }
  assert.equal((await q(`SELECT "FirstName" FROM "Order" WHERE "ID" = $1`, [ids.order])).rows[0].FirstName, 'Jane');
});
