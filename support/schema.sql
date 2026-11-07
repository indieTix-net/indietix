-- IndieTix support inbox: tables in the `indietix` platform database (IndieTix's
-- own data, never a venue database). Run as the database owner. Idempotent.
-- No foreign keys, per the platform convention; SupportMessage."TicketID"
-- points at SupportTicket."ID" and the code keeps them consistent.

CREATE TABLE IF NOT EXISTS "SupportTicket" (
  "ID" SERIAL PRIMARY KEY,
  "Subject" TEXT NOT NULL,
  "CustomerEmail" VARCHAR(320) NOT NULL,
  "CustomerName" VARCHAR(200),
  "Status" VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK ("Status" IN ('open', 'waiting', 'closed', 'spam')),
  "CreatedDate" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "UpdatedDate" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "LastMessageDate" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SupportTicket_Status_Last" ON "SupportTicket" ("Status", "LastMessageDate" DESC);

CREATE TABLE IF NOT EXISTS "SupportMessage" (
  "ID" SERIAL PRIMARY KEY,
  "TicketID" INTEGER NOT NULL,
  "Direction" VARCHAR(3) NOT NULL CHECK ("Direction" IN ('in', 'out')),
  "MessageID" VARCHAR(998),
  "InReplyTo" VARCHAR(998),
  "FromAddress" VARCHAR(320) NOT NULL,
  "FromName" VARCHAR(200),
  "ToAddresses" TEXT,
  "Subject" TEXT,
  "BodyText" TEXT,
  "Attachments" JSONB NOT NULL DEFAULT '[]',
  "S3Key" TEXT,
  "Skipped" VARCHAR(40),
  "Draft" TEXT,
  "DraftModel" VARCHAR(60),
  "DraftDate" TIMESTAMPTZ,
  "SentBy" VARCHAR(100),
  "CreatedDate" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SupportMessage_Ticket" ON "SupportMessage" ("TicketID", "CreatedDate");
-- One row per email even if SES delivers it twice.
CREATE UNIQUE INDEX IF NOT EXISTS "SupportMessage_MessageID" ON "SupportMessage" ("MessageID") WHERE "MessageID" IS NOT NULL;
