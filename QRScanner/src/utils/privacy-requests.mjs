// Customer privacy requests (QRScanner's PRIVACY REQUESTS routes): find
// everything a venue's database holds about one person, export it, or
// redact it. Redacting replaces the personal details and keeps the records,
// so sales, refunds, attendance and box-office reports stay correct.
//
// What redaction does, table by table:
//   "Order", "QRCodeProduct", "Customer"  name -> "Redacted", email/phone
//       cleared (Customer's phone, which must be unique, becomes a
//       fingerprint), opt-in link token cleared, and personal fields inside
//       Square's stored order/line-item JSON replaced (scrubPersonalJson).
//   "SmsOutboundLog"  phone -> fingerprint, message preview cleared.
//   "MarketingEmailContact"  email -> a unique placeholder, unsubscribed.
//   "ApiIdempotency"  replayed API responses mentioning them are deleted
//       (a cache, not a record).
//   "SmsConsent"  KEPT as-is, because it's the legal proof of consent to
//       texts; any active consent is revoked so no more texts are sent.
// Ticket PDFs carry no customer details, so tickets keep working.

import crypto from 'crypto';
import { normalizeToE164 } from 'sms-utils';

export const REDACTED_NAME = 'Redacted';

// Keys inside Square's order/line-item JSON that hold personal details
// (pickup/shipment recipients, card holder and card identifiers, Square
// customer IDs, register ticket names, free-text notes). Matched at any
// depth, case-insensitively.
const PERSONAL_JSON_KEYS = new Set([
  'recipient', 'cardholder_name', 'fingerprint', 'payment_account_reference', 'bin', 'last_4',
  'exp_month', 'exp_year', 'customer_id', 'ticket_name', 'note', 'shipping_note',
  'buyer_email_address', 'email_address', 'phone_number', 'display_name', 'first_name',
  'last_name', 'given_name', 'family_name', 'nickname', 'company_name', 'address',
  'address_line_1', 'address_line_2', 'address_line_3', 'billing_address', 'shipping_address',
  'birthday'
]);

export function scrubPersonalJson(value) {
  if (Array.isArray(value)) return value.map(scrubPersonalJson);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = PERSONAL_JSON_KEYS.has(key.toLowerCase()) && item !== null && item !== '' ? 'REDACTED' : scrubPersonalJson(item);
  }
  return out;
}

// Returns { email, phone, last10 } or { error }.
export function normalizeSubject({ email, phone } = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const rawPhone = String(phone || '').trim();
  const subject = { email: null, phone: null, last10: null };
  if (cleanEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return { error: 'That email address does not look right' };
    subject.email = cleanEmail;
  }
  if (rawPhone) {
    const e164 = normalizeToE164(rawPhone);
    if (!e164) return { error: 'That phone number does not look right' };
    subject.phone = e164;
    subject.last10 = e164.replace(/\D/g, '').slice(-10);
  }
  if (!subject.email && !subject.phone) return { error: 'Enter the email address or phone number the person used' };
  return subject;
}

// One-way, venue-specific fingerprint of a value (the log never stores
// the email or phone itself).
export function fingerprint(clientId, value) {
  return crypto.createHash('sha256').update(`indietix-privacy:${clientId}:${value}`).digest('hex');
}

export function subjectFingerprint(clientId, subject) {
  return fingerprint(clientId, [subject.email || '', subject.phone || ''].join('|'));
}

// Matches a stored phone in any format by its last ten digits.
const phoneMatch = (column, param) => `right(regexp_replace(coalesce(${column}, ''), '\\D', '', 'g'), 10) = ${param}`;

// Every record about the person. Each list is of full rows.
export async function findSubjectRecords(db, subject) {
  const email = subject.email;
  const last10 = subject.last10;
  const e164 = subject.phone;
  const p = [email, last10, e164];
  // $1 email, $2 last ten digits, $3 E.164 -- each may be null
  const emailCol = (col) => `($1::text IS NOT NULL AND lower(${col}) = $1)`;
  const phoneCol = (col) => `($2::text IS NOT NULL AND ${phoneMatch(col, '$2')})`;
  const inJson = (col) => `(($1::text IS NOT NULL AND lower(${col}::text) LIKE '%' || $1 || '%') OR ($3::text IS NOT NULL AND ${col}::text LIKE '%' || $3 || '%'))`;

  const orders = (await db.query(
    `SELECT * FROM "Order"
     WHERE ${emailCol('"EmailAddress"')} OR ${phoneCol('"PhoneNumber"')} OR ${phoneCol('"OptInClaimedByPhone"')} OR ${inJson('"OrderMetaData"')}
     ORDER BY "ID"`, p)).rows;
  const orderIds = orders.map(o => o.ID);

  const tickets = (await db.query(
    `SELECT * FROM "QRCodeProduct"
     WHERE ${emailCol('"EmailAddress"')} OR ${phoneCol('"PhoneNumber"')}
        OR "ID" IN (SELECT "QRCodeProductID" FROM "QRCodeProductToOrder" WHERE "OrderID" = ANY($3::int[]))
     ORDER BY "ID"`, [email, last10, orderIds])).rows;

  const customers = (await db.query(
    `SELECT * FROM "Customer" WHERE ${emailCol('"Email"')} OR ${phoneCol('"PhoneNumber"')} ORDER BY "ID"`, [email, last10])).rows;
  const phones = [...new Set([e164, ...customers.map(c => c.PhoneNumber)].filter(Boolean))];

  const consents = (await db.query(
    `SELECT * FROM "SmsConsent" WHERE "PhoneNumber" = ANY($1::text[]) OR "CustomerID" = ANY($2::int[]) ORDER BY "ID"`,
    [phones, customers.map(c => c.ID)])).rows;
  const texts = (await db.query(
    `SELECT * FROM "SmsOutboundLog" WHERE "PhoneNumber" = ANY($1::text[]) ORDER BY "ID"`, [phones])).rows;
  const emailContacts = email ? (await db.query(
    `SELECT * FROM "MarketingEmailContact" WHERE lower("Email") = $1 ORDER BY "ID"`, [email])).rows : [];
  const apiReplays = (await db.query(
    `SELECT "ApiKeyID", "IdempotencyKey", "CreatedAt" FROM "ApiIdempotency"
     WHERE ($1::text IS NOT NULL AND lower("ResponseBody"::text) LIKE '%' || $1 || '%')
        OR ($2::text IS NOT NULL AND "ResponseBody"::text LIKE '%' || $2 || '%')`, [email, e164])).rows;

  return { orders, tickets, customers, consents, texts, emailContacts, apiReplays };
}

export function summarizeRecords(records) {
  return Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]));
}

// What staff see before acting: enough to recognize the right person.
export function previewRecords(records) {
  const name = (row) => [row.FirstName, row.LastName].filter(Boolean).join(' ') || '(no name)';
  return {
    counts: summarizeRecords(records),
    orders: records.orders.slice(0, 50).map(o => ({
      id: o.ID, orderId: o.OrderID, created: o.CreatedDate, status: o.Status, name: name(o),
      email: o.EmailAddress || null, phone: o.PhoneNumber || null
    })),
    tickets: records.tickets.slice(0, 100).map(t => ({
      id: t.ID, event: t.ProductName, showtime: t.ProductDate, type: t.ProductSeatCode, status: t.Status
    })),
    textConsent: records.consents.map(c => ({ status: c.Status, since: c.ConsentTimestamp || c.CreatedDate, revokedAt: c.RevokedAt }))
  };
}

// Everything the person may receive, minus internal link tokens.
export function exportRecords(records) {
  const strip = (rows, keys) => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))));
  return {
    orders: strip(records.orders, ['OptInToken']),
    tickets: records.tickets,
    customers: records.customers,
    textConsents: records.consents,
    textsSent: records.texts,
    emailList: strip(records.emailContacts, ['UnsubscribeToken'])
  };
}

// Redacts inside the caller's transaction (db is a connected client).
export async function redactRecords(db, clientId, subject, records) {
  const now = new Date().toISOString();
  const placeholderPhone = (value) => `R${fingerprint(clientId, value).slice(0, 15)}`;

  for (const order of records.orders) {
    const meta = scrubPersonalJson(order.OrderMetaData || {});
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) meta.privacyRedaction = { redactedAt: now };
    await db.query(
      `UPDATE "Order" SET "FirstName" = $1, "LastName" = NULL, "EmailAddress" = NULL, "PhoneNumber" = NULL,
              "OptInToken" = NULL, "OptInClaimedByPhone" = NULL, "OrderMetaData" = $2::jsonb
       WHERE "ID" = $3`,
      [REDACTED_NAME, JSON.stringify(meta), order.ID]);
  }
  for (const ticket of records.tickets) {
    await db.query(
      `UPDATE "QRCodeProduct" SET "FirstName" = $1, "LastName" = NULL, "EmailAddress" = NULL, "PhoneNumber" = NULL,
              "ProductMetadata" = $2::jsonb
       WHERE "ID" = $3`,
      [REDACTED_NAME, JSON.stringify(scrubPersonalJson(ticket.ProductMetadata || {})), ticket.ID]);
  }
  for (const customer of records.customers) {
    await db.query(
      `UPDATE "Customer" SET "FirstName" = $1, "LastName" = NULL, "Email" = NULL, "PhoneNumber" = $2, "UpdatedDate" = CURRENT_TIMESTAMP
       WHERE "ID" = $3`,
      [REDACTED_NAME, placeholderPhone(customer.PhoneNumber), customer.ID]);
  }
  // Consent records stay (legal proof); an active one is revoked.
  let consentsRevoked = 0;
  for (const consent of records.consents.filter(c => c.Status === 'active')) {
    await db.query(`UPDATE "SmsConsent" SET "Status" = 'revoked', "RevokedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1 AND "Status" = 'active'`, [consent.ID]);
    consentsRevoked++;
  }
  for (const text of records.texts) {
    await db.query(`UPDATE "SmsOutboundLog" SET "PhoneNumber" = $1, "BodyPreview" = NULL WHERE "ID" = $2`, [placeholderPhone(text.PhoneNumber), text.ID]);
  }
  for (const contact of records.emailContacts) {
    await db.query(
      `UPDATE "MarketingEmailContact" SET "Email" = $1, "Status" = 'unsubscribed' WHERE "ID" = $2`,
      [`redacted-${fingerprint(clientId, contact.Email.toLowerCase()).slice(0, 16)}@redacted.invalid`, contact.ID]);
  }
  for (const replay of records.apiReplays) {
    await db.query(`DELETE FROM "ApiIdempotency" WHERE "ApiKeyID" = $1 AND "IdempotencyKey" = $2`, [replay.ApiKeyID, replay.IdempotencyKey]);
  }
  return { ...summarizeRecords(records), consentsRevoked };
}
