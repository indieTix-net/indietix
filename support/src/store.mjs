// Support tickets and their messages (schema.sql). Every function takes the
// query function from db.mjs first.

export const RETENTION_YEARS = 2;

const asJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const message = (row) => row && { ...row, Attachments: asJson(row.Attachments) || [] };

export async function findMessageByMessageId(query, messageId) {
  if (!messageId) return null;
  const rows = await query(`SELECT * FROM "SupportMessage" WHERE "MessageID" = :messageId`, { messageId });
  return message(rows[0]) || null;
}

export async function getTicket(query, ticketId) {
  const rows = await query(`SELECT * FROM "SupportTicket" WHERE "ID" = :ticketId`, { ticketId });
  return rows[0] || null;
}

// Which existing ticket an incoming email belongs to: one of its In-Reply-To
// or References IDs is a message we have, or its subject carries a [T-n]
// token for a ticket from the same sender. Otherwise null (a new ticket).
export async function findTicketForEmail(query, { references = [], ticketNumber, fromAddress }) {
  for (const id of references) {
    const known = await findMessageByMessageId(query, id);
    if (known) return getTicket(query, known.TicketID);
  }
  if (ticketNumber) {
    const ticket = await getTicket(query, ticketNumber);
    if (ticket && ticket.CustomerEmail.toLowerCase() === String(fromAddress || '').toLowerCase()) return ticket;
  }
  return null;
}

export async function createTicket(query, { subject, customerEmail, customerName }) {
  const rows = await query(
    `INSERT INTO "SupportTicket" ("Subject", "CustomerEmail", "CustomerName")
     VALUES (:subject, :customerEmail, :customerName) RETURNING *`,
    { subject: subject || '(no subject)', customerEmail, customerName: customerName || null });
  return rows[0];
}

// Returns the new message, or null when this MessageID is already stored
// (SES can deliver the same email twice).
export async function addMessage(query, ticketId, m) {
  const rows = await query(
    `INSERT INTO "SupportMessage"
       ("TicketID", "Direction", "MessageID", "InReplyTo", "FromAddress", "FromName", "ToAddresses",
        "Subject", "BodyText", "Attachments", "S3Key", "Skipped", "SentBy")
     VALUES (:ticketId, :direction, :messageId, :inReplyTo, :fromAddress, :fromName, :toAddresses,
        :subject, :bodyText, CAST(:attachments AS jsonb), :s3Key, :skipped, :sentBy)
     ON CONFLICT ("MessageID") WHERE "MessageID" IS NOT NULL DO NOTHING
     RETURNING *`,
    {
      ticketId, direction: m.direction, messageId: m.messageId || null, inReplyTo: m.inReplyTo || null,
      fromAddress: m.fromAddress, fromName: m.fromName || null, toAddresses: m.toAddresses || null,
      subject: m.subject || null, bodyText: m.bodyText || null, attachments: JSON.stringify(m.attachments || []),
      s3Key: m.s3Key || null, skipped: m.skipped || null, sentBy: m.sentBy || null
    });
  if (!rows[0]) return null;
  // A new email from the customer reopens the ticket; our reply marks it waiting on them.
  await query(
    `UPDATE "SupportTicket" SET "LastMessageDate" = now(), "UpdatedDate" = now(),
       "Status" = CASE WHEN "Status" = 'spam' THEN 'spam' WHEN :direction = 'in' THEN 'open' ELSE 'waiting' END
     WHERE "ID" = :ticketId`,
    { ticketId, direction: m.direction });
  return message(rows[0]);
}

export async function saveDraft(query, messageId, { draft, model }) {
  await query(
    `UPDATE "SupportMessage" SET "Draft" = :draft, "DraftModel" = :model, "DraftDate" = now() WHERE "ID" = :messageId`,
    { messageId, draft, model: model || null });
}

// Emails from the last 24 hours that weren't skipped, i.e. ones that asked
// for an automatic draft (the daily draft limit counts these).
export async function countDraftableEmailsToday(query) {
  const rows = await query(
    `SELECT count(*)::int AS n FROM "SupportMessage"
     WHERE "Direction" = 'in' AND "Skipped" IS NULL AND "CreatedDate" > now() - interval '24 hours'`, {});
  return rows[0].n;
}

export async function listTickets(query, { status } = {}) {
  return query(
    `SELECT t.*,
       (SELECT count(*)::int FROM "SupportMessage" m WHERE m."TicketID" = t."ID") AS "MessageCount"
     FROM "SupportTicket" t
     WHERE (CAST(:status AS text) IS NULL OR t."Status" = :status)
       AND EXISTS (SELECT 1 FROM "SupportMessage" m WHERE m."TicketID" = t."ID")
     ORDER BY t."LastMessageDate" DESC LIMIT 200`,
    { status: status || null });
}

export async function getMessages(query, ticketId) {
  const rows = await query(`SELECT * FROM "SupportMessage" WHERE "TicketID" = :ticketId ORDER BY "CreatedDate", "ID"`, { ticketId });
  return rows.map(message);
}

export async function setStatus(query, ticketId, status) {
  const rows = await query(
    `UPDATE "SupportTicket" SET "Status" = :status, "UpdatedDate" = now() WHERE "ID" = :ticketId RETURNING *`,
    { ticketId, status });
  return rows[0] || null;
}

// Deletes tickets (and their messages) with no activity for RETENTION_YEARS.
export async function deleteExpired(query) {
  const expired = await query(
    `DELETE FROM "SupportTicket" WHERE "LastMessageDate" < now() - make_interval(years => CAST(:years AS integer)) RETURNING "ID"`,
    { years: RETENTION_YEARS });
  if (expired.length) {
    await query(
      `DELETE FROM "SupportMessage" WHERE "TicketID" NOT IN (SELECT "ID" FROM "SupportTicket")`, {});
  }
  return expired.length;
}
