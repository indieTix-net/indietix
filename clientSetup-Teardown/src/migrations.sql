-- ============================================================
-- IndieTix SMS Opt-In / Consent Migration
-- ============================================================
-- Adds Customer + SmsConsent tables, OptInToken / CustomerID
-- columns, updates Users.Permissions default to least-privilege,
-- and patches the per-client Configuration JSON.
--
-- Idempotent: safe to re-run.
-- No foreign keys (matches existing schema convention).
-- Run per-client database (the database named after the client ID).
-- ============================================================

BEGIN;

-- =====================================================
-- SECTION 1: SCHEMA CHANGES
-- =====================================================

-- 1. Customer table -- one row per unique phone number.
--    Phone is the SMS identity; email is indexed but not unique
--    (family members may share an email).
CREATE TABLE IF NOT EXISTS public."Customer" (
  "ID" SERIAL PRIMARY KEY,
  "PhoneNumber" VARCHAR(20) NOT NULL,
  "Email" VARCHAR(420),
  "FirstName" VARCHAR(420),
  "LastName" VARCHAR(420),
  "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Customer_PhoneNumber_key" UNIQUE ("PhoneNumber")
);

CREATE INDEX IF NOT EXISTS "idx_customer_email" ON public."Customer" ("Email");
CREATE INDEX IF NOT EXISTS "idx_customer_phone" ON public."Customer" ("PhoneNumber");


-- 2. SmsConsent -- immutable audit log of every consent event.
--    Never UPDATE history; only flip Status + RevokedAt, and INSERT
--    new rows for resubscribes (linked back via PreviousConsentID).
CREATE TABLE IF NOT EXISTS public."SmsConsent" (
  "ID" SERIAL PRIMARY KEY,
  "CustomerID" INTEGER NOT NULL,
  "PhoneNumber" VARCHAR(20) NOT NULL,
  "Status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "OptInMethod" VARCHAR(50) NOT NULL,
  "ConsentText" TEXT NOT NULL,
  "ConsentURL" VARCHAR(500),
  "IPAddress" VARCHAR(45),
  "UserAgent" TEXT,
  "CampaignID" VARCHAR(100),
  "PreviousConsentID" INTEGER,
  "ConsentTimestamp" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "RevokedAt" TIMESTAMP WITHOUT TIME ZONE,
  "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsConsent_Status_check" CHECK ("Status" IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS "idx_smsconsent_customer"     ON public."SmsConsent" ("CustomerID");
CREATE INDEX IF NOT EXISTS "idx_smsconsent_phone"        ON public."SmsConsent" ("PhoneNumber");
CREATE INDEX IF NOT EXISTS "idx_smsconsent_phone_status" ON public."SmsConsent" ("PhoneNumber", "Status");

-- A phone can have at most ONE active consent at a time.
-- Revoked rows are unconstrained (audit history accumulates).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_smsconsent_active_phone_unique"
  ON public."SmsConsent" ("PhoneNumber") WHERE "Status" = 'active';


-- 3. Order: add OptInToken (the URL token in /opt-in/{token}) and CustomerID
ALTER TABLE public."Order"
  ADD COLUMN IF NOT EXISTS "OptInToken" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "CustomerID" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_order_optintoken" ON public."Order" ("OptInToken");
CREATE        INDEX IF NOT EXISTS "idx_order_customerid" ON public."Order" ("CustomerID");


-- 4. QRCodeProduct: add CustomerID for fast customer-to-ticket lookups
ALTER TABLE public."QRCodeProduct"
  ADD COLUMN IF NOT EXISTS "CustomerID" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_qrcodeproduct_customerid" ON public."QRCodeProduct" ("CustomerID");


-- 5. Users: update Permissions default to least-privilege (checkIn only).
--    Existing user rows are untouched -- only affects future inserts
--    that don't explicitly specify Permissions.
ALTER TABLE public."Users"
  ALTER COLUMN "Permissions"
  SET DEFAULT '{"view": false, "edit": false, "checkIn": true}'::json;


-- =====================================================
-- SECTION 2: CONFIGURATION PATCHES
-- Updates the Client row in this database.
-- Each client DB contains only its own Client row.
-- =====================================================

-- 6. Add new SMS / 10DLC configuration keys.
--    jsonb || merges, so re-running is a no-op (idempotent).
UPDATE public."Client"
SET "configuration" = "configuration"::jsonb 
  || '{
    "SMS_CAMPAIGN_ID": "",
    "SMS_ORIGINATION_NUMBER": "",
    "SMS_SENDER_BRAND": "IndieTix",
    "INDIETIX_PRIVACY_URL": "https://indietix.com/privacy",
    "INDIETIX_TERMS_URL": "https://indietix.com/terms"
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP;


-- 7. Update SQL_QUERY to point to the renamed function.
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{SQL_QUERY}',
  '"SELECT * FROM get_bdor_grouped_for_date($1, $2, $3)"'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;


-- 8. Replace USER_DEFINABLE with the complete known-good list.
--    Idempotent because we overwrite the entire array rather than appending.
--    Order matches the order in the client-setup script's insertClientRecord
--    function so both sources stay in sync.
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


-- ============================================================
-- 2026-08-03: SMS spend circuit breaker + vertical SMS ticket config
-- ============================================================
-- Adds SmsOutboundLog (feeds the spend circuit breaker in
-- utils/sms.mjs) and patches the per-client configuration JSON with
-- keys that were added to clientSetup-Teardown/src/index.js's
-- insertClientRecord default but never backfilled onto existing
-- client databases.
--
-- Idempotent: safe to re-run.
-- No foreign keys (matches existing schema convention).
-- Run per-client database (the database named after the client ID).
-- ============================================================

BEGIN;

-- =====================================================
-- SECTION 1: SCHEMA CHANGES
-- =====================================================

-- 1. SmsOutboundLog -- append-only audit log of every successful
--    outbound SMS. Feeds the spend circuit breaker in utils/sms.mjs,
--    which counts rows in the last 5 minutes and refuses new sends
--    over SMS_SPEND_LIMIT_PER_5MIN (default 300). Rows older than
--    SMS_LOG_RETENTION_DAYS (default 30) are pruned probabilistically
--    by utils/sms.mjs.
CREATE TABLE IF NOT EXISTS public."SmsOutboundLog" (
  "ID" SERIAL PRIMARY KEY,
  "PhoneNumber" VARCHAR(20) NOT NULL,
  "MessageID" VARCHAR(255),
  "BodyPreview" VARCHAR(160),
  "SentAt" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The circuit breaker query filters on SentAt >= now - 5 min every
-- send, so it needs an index or the query slows linearly as the
-- table grows.
CREATE INDEX IF NOT EXISTS "idx_smsoutboundlog_sentat" ON public."SmsOutboundLog" ("SentAt");

-- =====================================================
-- SECTION 2: CONFIGURATION PATCHES
-- Updates the Client row in this database.
-- Each client DB contains only its own Client row.
-- =====================================================

-- 2. Add ticket-orientation and spend-breaker config keys that exist
--    in insertClientRecord's default but were never backfilled here.
--    jsonb || merges, so re-running is a no-op (idempotent).
UPDATE public."Client"
SET "configuration" = "configuration"::jsonb
  || '{
    "TICKET_FILENAME": "ticket_horizontal.pdf",
    "TICKET_ORIENTATION": "horizontal",
    "TICKET_SMS_FILENAME": "ticket_vertical.pdf",
    "TICKET_SMS_ORIENTATION": "vertical",
    "SMS_OPT_OUT_LIST_NAME": "",
    "SMS_SPEND_LIMIT_PER_5MIN": 300,
    "SMS_LOG_RETENTION_DAYS": 30
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'SMS_SPEND_LIMIT_PER_5MIN');

-- 3. Replace USER_DEFINABLE with the complete known-good list,
--    adding SMS_OPT_OUT_LIST_NAME, SMS_SPEND_LIMIT_PER_5MIN, and
--    SMS_LOG_RETENTION_DAYS. Idempotent because we overwrite the
--    entire array rather than appending. Order matches the order in
--    the client-setup script's insertClientRecord function so both
--    sources stay in sync.
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


-- ============================================================
-- 2026-08-30: FILM_CODE_PREFIX config backfill
-- ============================================================
-- clientSetup-Teardown/src/index.js's createDatabaseObjects now bakes a
-- per-client film-code prefix into bdor_for_date at creation time
-- (previously hardcoded to the first venue's prefix for every client). This only affects
-- NEW clients going forward -- it does not retroactively change an
-- existing client's bdor_for_date function, since the prefix is
-- interpolated into the function body at creation, not read at query
-- time. Run this against each existing client database to record what
-- prefix is actually baked into their function already, so the
-- configuration JSON matches reality. The prefix is read straight out of
-- the venue's existing bdor_for_date definition, so it records exactly
-- what's baked in (nothing is set if the function or prefix isn't found).
--
-- Idempotent: safe to re-run.
-- Run per-client database.
-- ============================================================

BEGIN;

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || jsonb_build_object('FILM_CODE_PREFIX', baked.prefix),
  "updatedDate" = CURRENT_TIMESTAMP
FROM (
  SELECT substring(pg_get_functiondef(to_regprocedure('public.bdor_for_date(date)'))
                   FROM '''([A-Z0-9]{2,4})''::text \|\| substring\(md5') AS prefix
) AS baked
WHERE NOT ("configuration"::jsonb ? 'FILM_CODE_PREFIX')
  AND baked.prefix IS NOT NULL;

UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  (
    SELECT jsonb_agg(DISTINCT elem)
    FROM jsonb_array_elements("configuration"::jsonb -> 'USER_DEFINABLE') AS elem
  ) || '["FILM_CODE_PREFIX"]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb -> 'USER_DEFINABLE' ? 'FILM_CODE_PREFIX');

COMMIT;


-- ============================================================
-- 2026-08-31: Reconcile USER_DEFINABLE + config keys with reality
-- ============================================================
-- A diff of the first venue's live configuration against
-- clientSetup-Teardown/src/index.js turned up drift in both
-- directions:
--   1. Five keys exist live (with real values) but were never added
--      to insertClientRecord's defaults or USER_DEFINABLE:
--      SQUARE_LOCATION_ID, WEB_HEADER_COMPANY, LOGO_FILE,
--      EBOR_THEATRE_NO, BAD_SHOWTIME_SNS_TOPIC_ARN.
--   2. Three keys were added to USER_DEFINABLE in the 2026-08-03
--      migration above (SMS_OPT_OUT_LIST_NAME, SMS_SPEND_LIMIT_PER_5MIN,
--      SMS_LOG_RETENTION_DAYS) but that migration's USER_DEFINABLE
--      replacement was apparently never actually run against
--      production -- the live array was still missing all three,
--      even though the config *values* for two of them were present
--      (confirming the SET "configuration" = ... || defaults section
--      ran, but this section didn't).
--
-- Section 1 backfills the 5 missing keys with placeholder/empty
-- defaults ONLY if genuinely absent, so it never clobbers an existing
-- client's real values (a no-op for a venue that already has real
-- values for all five; it matters for any client database missing them).
--
-- Section 2 replaces USER_DEFINABLE outright with the complete,
-- current list from index.js, superseding the incomplete replacement
-- in the 2026-08-03 migration.
--
-- Idempotent: safe to re-run.
-- Run per-client database.
-- ============================================================

BEGIN;

-- Section 1: backfill missing keys, one at a time so a partially-set
-- client database only gets the keys it's actually missing.
UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{"SQUARE_LOCATION_ID": ""}'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'SQUARE_LOCATION_ID');

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb
  || jsonb_build_object('WEB_HEADER_COMPANY', "configuration"::jsonb ->> 'THEATER_NAME'),
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'WEB_HEADER_COMPANY');

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{"LOGO_FILE": "indieTixLogo.png"}'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'LOGO_FILE');

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{"EBOR_THEATRE_NO": ""}'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'EBOR_THEATRE_NO');

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{"BAD_SHOWTIME_SNS_TOPIC_ARN": ""}'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'BAD_SHOWTIME_SNS_TOPIC_ARN');

-- Section 2: replace USER_DEFINABLE with the complete, current list.
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "SQUARE_LOCATION_ID",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "WEB_HEADER_COMPANY",
    "LOGO_FILE",
    "EBOR_THEATRE_NO",
    "FILM_CODE_PREFIX",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "BAD_SHOWTIME_SNS_TOPIC_ARN",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


BEGIN;

-- Add FTP3_* config keys (third FTP/SFTP destination for DailyPgQueryAndSftp;
-- carries the same TDI CSV report as FTP2) to existing clients that predate them.
UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{
    "FTP3_HOST": "",
    "FTP3_PASSWORD": "",
    "FTP3_PORT": "21",
    "FTP3_REMOTE_PATH": "",
    "FTP3_TYPE": "ftp",
    "FTP3_USER": ""
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'FTP3_HOST');

-- Replace USER_DEFINABLE with the complete known-good list, now including FTP3_*.
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "SQUARE_LOCATION_ID",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "FTP3_HOST",
    "FTP3_PASSWORD",
    "FTP3_PORT",
    "FTP3_REMOTE_PATH",
    "FTP3_TYPE",
    "FTP3_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "WEB_HEADER_COMPANY",
    "LOGO_FILE",
    "EBOR_THEATRE_NO",
    "FILM_CODE_PREFIX",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "BAD_SHOWTIME_SNS_TOPIC_ARN",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


-- 2026-09-28: Marquee Engine schema (marketing tables + config)
-- Purely additive: three new tables, a new Users.Permissions default key
-- (existing rows untouched, same precedent as the checkIn backfill above),
-- and new Client.configuration keys, all defaulting to disabled/empty.
-- MARKETING_ENGINE_ENABLED gates whether the marketingEngine Lambda does
-- anything at all for a given client -- everything here is inert until a
-- client explicitly opts in.

BEGIN;

-- =====================================================
-- SECTION 1: SCHEMA
-- =====================================================

CREATE TABLE IF NOT EXISTS public."MarketingSchedule" (
  "ID" SERIAL PRIMARY KEY,
  "SquareItemID" VARCHAR(100) NOT NULL,
  "Channel" VARCHAR(20) NOT NULL,
  "PhaseConfig" JSONB NOT NULL,
  "Enabled" BOOLEAN NOT NULL DEFAULT true,
  "UseAiCaptions" BOOLEAN NOT NULL DEFAULT false,
  "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingSchedule_Channel_check" CHECK ("Channel" IN ('email', 'facebook', 'instagram', 'tiktok')),
  CONSTRAINT "MarketingSchedule_item_channel_key" UNIQUE ("SquareItemID", "Channel")
);
CREATE INDEX IF NOT EXISTS "idx_marketingschedule_item" ON public."MarketingSchedule" ("SquareItemID");

CREATE TABLE IF NOT EXISTS public."MarketingPost" (
  "ID" SERIAL PRIMARY KEY,
  "SquareItemID" VARCHAR(100) NOT NULL,
  "Channel" VARCHAR(20) NOT NULL,
  "PostType" VARCHAR(20) NOT NULL DEFAULT 'campaign',
  "ScheduledFor" TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  "Status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "FailureReason" VARCHAR(500),
  "PlatformPostID" VARCHAR(255),
  "PostContent" JSONB,
  "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingPost_Channel_check" CHECK ("Channel" IN ('email', 'facebook', 'instagram', 'tiktok')),
  CONSTRAINT "MarketingPost_PostType_check" CHECK ("PostType" IN ('campaign', 'digest', 'low_inventory')),
  CONSTRAINT "MarketingPost_Status_check" CHECK ("Status" IN ('draft', 'approved', 'sent', 'failed', 'skipped')),
  CONSTRAINT "MarketingPost_slot_key" UNIQUE ("SquareItemID", "Channel", "PostType", "ScheduledFor")
);
CREATE INDEX IF NOT EXISTS "idx_marketingpost_due" ON public."MarketingPost" ("Status", "ScheduledFor");
CREATE INDEX IF NOT EXISTS "idx_marketingpost_item" ON public."MarketingPost" ("SquareItemID");

CREATE TABLE IF NOT EXISTS public."MarketingEmailContact" (
  "ID" SERIAL PRIMARY KEY,
  "Email" VARCHAR(420) NOT NULL,
  "Status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "UnsubscribeToken" VARCHAR(32) NOT NULL,
  "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingEmailContact_Status_check" CHECK ("Status" IN ('active', 'unsubscribed')),
  CONSTRAINT "MarketingEmailContact_Email_key" UNIQUE ("Email"),
  CONSTRAINT "MarketingEmailContact_UnsubscribeToken_key" UNIQUE ("UnsubscribeToken")
);
CREATE INDEX IF NOT EXISTS "idx_marketingemailcontact_status" ON public."MarketingEmailContact" ("Status");

-- Existing user rows are untouched -- only affects future inserts that
-- don't explicitly specify Permissions (same precedent as the checkIn
-- default added in Section 5 above).
ALTER TABLE public."Users"
  ALTER COLUMN "Permissions"
  SET DEFAULT '{"view": false, "edit": false, "checkIn": true, "marketing": false}'::json;

-- =====================================================
-- SECTION 2: CONFIGURATION PATCHES
-- =====================================================

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{
    "MARKETING_ENGINE_ENABLED": "false",
    "DIGEST_ENABLED": "false",
    "DIGEST_DAY_OF_WEEK": "monday",
    "DIGEST_TIME": "10:00",
    "DIGEST_CHANNELS": ["email"],
    "MARKETING_SES_CONFIGURATION_SET": "",
    "SHARE_NUDGE_ENABLED": "false",
    "META_PAGE_ACCESS_TOKEN": "",
    "META_IG_BUSINESS_ID": "",
    "TIKTOK_ACCESS_TOKEN": ""
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'MARKETING_ENGINE_ENABLED');

UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "SQUARE_LOCATION_ID",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "FTP3_HOST",
    "FTP3_PASSWORD",
    "FTP3_PORT",
    "FTP3_REMOTE_PATH",
    "FTP3_TYPE",
    "FTP3_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "WEB_HEADER_COMPANY",
    "LOGO_FILE",
    "EBOR_THEATRE_NO",
    "FILM_CODE_PREFIX",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "BAD_SHOWTIME_SNS_TOPIC_ARN",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL",
    "MARKETING_ENGINE_ENABLED",
    "DIGEST_ENABLED",
    "DIGEST_DAY_OF_WEEK",
    "DIGEST_TIME",
    "DIGEST_CHANNELS",
    "MARKETING_SES_CONFIGURATION_SET",
    "SHARE_NUDGE_ENABLED",
    "META_PAGE_ACCESS_TOKEN",
    "META_IG_BUSINESS_ID",
    "TIKTOK_ACCESS_TOKEN"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


-- ============================================================
-- 2026-10-13: "admin" Users.Permissions flag
-- ============================================================
-- Gates access to client.html (Client Settings) and insights.html on the
-- QRScanner site. Previously insights.html was gated on "edit" and
-- client.html was clients-only; both pages now require this new flag
-- instead (client.html still also allows the master client login, same
-- as before). Existing rows untouched -- only affects future inserts
-- that don't explicitly specify Permissions, same precedent as the
-- checkIn/marketing defaults above.
-- ============================================================

BEGIN;

ALTER TABLE public."Users"
  ALTER COLUMN "Permissions"
  SET DEFAULT '{"view": false, "edit": false, "checkIn": true, "marketing": false, "admin": false}'::json;

COMMIT;


-- ============================================================
-- 2026-10-19: Real social senders (Phase 6) -- two new config keys
-- ============================================================
-- META_PAGE_ID: the Facebook Page real sending posts to (alongside the
-- existing META_PAGE_ACCESS_TOKEN). TIKTOK_PRIVACY_LEVEL: optional
-- override for the privacy_level sent on a TikTok post; if unset or not
-- one of the creator's actual privacy_level_options, the sender falls
-- back to the first option TikTok's creator_info query offers. Both
-- default to "" (not yet configured) -- sendDuePost() in marketingEngine
-- dry-runs that channel until real values are populated, same as the
-- existing META_PAGE_ACCESS_TOKEN/META_IG_BUSINESS_ID/TIKTOK_ACCESS_TOKEN
-- keys already do.
-- ============================================================

BEGIN;

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{
    "META_PAGE_ID": "",
    "TIKTOK_PRIVACY_LEVEL": ""
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'META_PAGE_ID');

UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "SQUARE_LOCATION_ID",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "FTP3_HOST",
    "FTP3_PASSWORD",
    "FTP3_PORT",
    "FTP3_REMOTE_PATH",
    "FTP3_TYPE",
    "FTP3_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "WEB_HEADER_COMPANY",
    "LOGO_FILE",
    "EBOR_THEATRE_NO",
    "FILM_CODE_PREFIX",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "BAD_SHOWTIME_SNS_TOPIC_ARN",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL",
    "MARKETING_ENGINE_ENABLED",
    "DIGEST_ENABLED",
    "DIGEST_DAY_OF_WEEK",
    "DIGEST_TIME",
    "DIGEST_CHANNELS",
    "MARKETING_SES_CONFIGURATION_SET",
    "SHARE_NUDGE_ENABLED",
    "META_PAGE_ACCESS_TOKEN",
    "META_PAGE_ID",
    "META_IG_BUSINESS_ID",
    "TIKTOK_ACCESS_TOKEN",
    "TIKTOK_PRIVACY_LEVEL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


-- ============================================================
-- 2026-10-21: TikTok token refresh (three new config keys)
-- ============================================================
-- TikTok access tokens expire in ~24h; the refresh token lasts ~365 days
-- but rotates on every redemption. marketingEngine's refreshTikTokToken()
-- now refreshes (and persists the rotated access+refresh pair) before
-- every TikTok send, but only once TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET
-- (the venue's TikTok developer app credentials) and TIKTOK_REFRESH_TOKEN
-- (from the same OAuth exchange as the existing TIKTOK_ACCESS_TOKEN) are
-- all set. All three default to "" -- a client with only the existing
-- static TIKTOK_ACCESS_TOKEN keeps working exactly as before (just
-- without auto-refresh) until these are populated.
-- ============================================================

BEGIN;

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{
    "TIKTOK_REFRESH_TOKEN": "",
    "TIKTOK_CLIENT_KEY": "",
    "TIKTOK_CLIENT_SECRET": ""
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'TIKTOK_REFRESH_TOKEN');

UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "SQUARE_LOCATION_ID",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "FTP3_HOST",
    "FTP3_PASSWORD",
    "FTP3_PORT",
    "FTP3_REMOTE_PATH",
    "FTP3_TYPE",
    "FTP3_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "WEB_HEADER_COMPANY",
    "LOGO_FILE",
    "EBOR_THEATRE_NO",
    "FILM_CODE_PREFIX",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "BAD_SHOWTIME_SNS_TOPIC_ARN",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL",
    "MARKETING_ENGINE_ENABLED",
    "DIGEST_ENABLED",
    "DIGEST_DAY_OF_WEEK",
    "DIGEST_TIME",
    "DIGEST_CHANNELS",
    "MARKETING_SES_CONFIGURATION_SET",
    "SHARE_NUDGE_ENABLED",
    "META_PAGE_ACCESS_TOKEN",
    "META_PAGE_ID",
    "META_IG_BUSINESS_ID",
    "TIKTOK_ACCESS_TOKEN",
    "TIKTOK_REFRESH_TOKEN",
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "TIKTOK_PRIVACY_LEVEL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;


-- ============================================================
-- 2026-10-24: bdor_for_date recognizes Status = 'transferred'
-- ============================================================
-- New for the ticket-transfer feature: transferring a ticket leaves the
-- OLD QRCodeProduct row behind with Status = 'transferred' (a brand new
-- row with the same showtime/price/seat carries the real sale forward
-- under a new QR code). Without this fix, bdor_for_date has no idea what
-- 'transferred' means and falls through to its default (non-refunded)
-- branch -- the old row would report as a second full-price sale right
-- alongside the new one, double-counting revenue and attendance in the
-- real box-office reports sent to distributors via DailyPgQueryAndSftp.
--
-- Treated like 'refunded' for Gross/Net/Tax/Sold (all zero), but NOT
-- like refunded for the "Refunded" column -- no money came back, so it
-- reports refunded=0 too. The old row simply contributes nothing.
--
-- This function's body has per-client literals baked in at CREATE time
-- (TheatreID, Theatre Name, Film Code prefix) rather than reading them
-- from config at query time, so the block below reads this venue's own
-- THEATER_ID, THEATER_NAME and FILM_CODE_PREFIX from its configuration
-- (the same values createDatabaseObjects bakes in at onboarding),
-- validates them, and recreates the function with them. It stops with an
-- error, changing nothing, if any of the three is missing or malformed.
-- New clients created after this date in clientSetup-Teardown's
-- createDatabaseObjects already get the fix automatically.
--
-- Idempotent: CREATE OR REPLACE FUNCTION is always safe to re-run.
-- Run per-client database.
-- ============================================================

DO $migration$
DECLARE
  cfg jsonb;
  theatre_id text;
  theatre_name text;
  film_code_prefix text;
BEGIN
  SELECT "configuration"::jsonb INTO cfg FROM public."Client" LIMIT 1;
  theatre_id := cfg->>'THEATER_ID';
  theatre_name := cfg->>'THEATER_NAME';
  film_code_prefix := cfg->>'FILM_CODE_PREFIX';
  IF theatre_id IS NULL OR theatre_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'bdor_for_date: THEATER_ID must be digits, got %', coalesce(theatre_id, '(missing)');
  END IF;
  IF coalesce(theatre_name, '') = '' THEN
    RAISE EXCEPTION 'bdor_for_date: THEATER_NAME is missing';
  END IF;
  IF film_code_prefix IS NULL OR film_code_prefix !~ '^[A-Z0-9]{2,4}$' THEN
    RAISE EXCEPTION 'bdor_for_date: FILM_CODE_PREFIX must be 2-4 uppercase letters/digits, got %', coalesce(film_code_prefix, '(missing)');
  END IF;

  EXECUTE format($sql$
CREATE OR REPLACE FUNCTION public.bdor_for_date(p_report_date date)
 RETURNS TABLE("TheatreID" integer, "Theatre Name" text, "Film Code" text, "Screen" text, "Title" character varying, "Distributor" character varying, "Showtime" text, "Ticket Type" character varying, "Gross" numeric, "Net" numeric, "Tax" numeric, "Sold" integer, "Refunded" integer, "Open" integer, "Close" integer)
 LANGUAGE sql
 STABLE
AS $fn$
    SELECT
        %s AS "TheatreID",
        %L::text AS "Theatre Name",
        %L::text || substring(md5("ProductName"::text), 1, 6) AS "Film Code",
        CASE
            WHEN "ProductVenue"::text ILIKE '%%little%%' THEN '2'::text
            ELSE '1'::text
        END AS "Screen",
        "ProductName" AS "Title",
        "Distributor",
        to_char("ProductDate", 'YYYYMMDDHH24MI') AS "Showtime",
        "ProductSeatCode" AS "Ticket Type",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred') THEN 0::numeric
            ELSE round("ProductPrice", 2)
        END AS "Gross",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred') THEN 0::numeric
            ELSE round("ProductPrice" / 1.093, 2)
        END AS "Net",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred') THEN 0::numeric
            ELSE round("ProductPrice", 2) - round("ProductPrice" / 1.093, 2)
        END AS "Tax",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred') THEN 0
            WHEN "ProductPrice" > 0::numeric THEN 1
            ELSE 0
        END AS "Sold",
        CASE
            WHEN "Status"::text = 'refunded' THEN 1
            ELSE 0
        END AS "Refunded",
        0 AS "Open",
        1 AS "Close"
    FROM "QRCodeProduct"
    WHERE "ProductType"::text = 'Movie'
      AND "ProductDate" IS NOT NULL
      AND "ProductDate"::date = p_report_date;
$fn$;
$sql$, theatre_id::integer, theatre_name, film_code_prefix);
END
$migration$;


-- ============================================================
-- 2026-10-25: bdor_for_date recognizes Status = 'cancelled'
-- ============================================================
-- Found while writing clientSetup-Teardown's test suite: QRScanner's
-- whole-order cancellation feature (src/app.mjs, ~line 3548) sets
-- QRCodeProduct.Status = 'cancelled' on every ticket in a cancelled
-- order. bdor_for_date only checked Status IN ('refunded', 'transferred')
-- -- it had no idea what 'cancelled' meant and fell through to the
-- default (non-refunded) branch, so a cancelled order's tickets were
-- being reported as full-price sales in the real box-office reports
-- sent to distributors via DailyPgQueryAndSftp.
--
-- Treated exactly like 'transferred': zero everywhere (Gross/Net/Tax/
-- Sold), but NOT counted in "Refunded" either -- cancelling an order
-- isn't necessarily a refund, so it just contributes nothing rather than
-- being misclassified as a refund.
--
-- Same per-client-baked-in-literals handling as the 2026-10-24 migration
-- above: the block reads this venue's own values from its configuration.
-- New clients created after this date in clientSetup-Teardown's
-- createDatabaseObjects already get the fix automatically.
--
-- Idempotent: CREATE OR REPLACE FUNCTION is always safe to re-run.
-- Run per-client database.
-- ============================================================

DO $migration$
DECLARE
  cfg jsonb;
  theatre_id text;
  theatre_name text;
  film_code_prefix text;
BEGIN
  SELECT "configuration"::jsonb INTO cfg FROM public."Client" LIMIT 1;
  theatre_id := cfg->>'THEATER_ID';
  theatre_name := cfg->>'THEATER_NAME';
  film_code_prefix := cfg->>'FILM_CODE_PREFIX';
  IF theatre_id IS NULL OR theatre_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'bdor_for_date: THEATER_ID must be digits, got %', coalesce(theatre_id, '(missing)');
  END IF;
  IF coalesce(theatre_name, '') = '' THEN
    RAISE EXCEPTION 'bdor_for_date: THEATER_NAME is missing';
  END IF;
  IF film_code_prefix IS NULL OR film_code_prefix !~ '^[A-Z0-9]{2,4}$' THEN
    RAISE EXCEPTION 'bdor_for_date: FILM_CODE_PREFIX must be 2-4 uppercase letters/digits, got %', coalesce(film_code_prefix, '(missing)');
  END IF;

  EXECUTE format($sql$
CREATE OR REPLACE FUNCTION public.bdor_for_date(p_report_date date)
 RETURNS TABLE("TheatreID" integer, "Theatre Name" text, "Film Code" text, "Screen" text, "Title" character varying, "Distributor" character varying, "Showtime" text, "Ticket Type" character varying, "Gross" numeric, "Net" numeric, "Tax" numeric, "Sold" integer, "Refunded" integer, "Open" integer, "Close" integer)
 LANGUAGE sql
 STABLE
AS $fn$
    SELECT
        %s AS "TheatreID",
        %L::text AS "Theatre Name",
        %L::text || substring(md5("ProductName"::text), 1, 6) AS "Film Code",
        CASE
            WHEN "ProductVenue"::text ILIKE '%%little%%' THEN '2'::text
            ELSE '1'::text
        END AS "Screen",
        "ProductName" AS "Title",
        "Distributor",
        to_char("ProductDate", 'YYYYMMDDHH24MI') AS "Showtime",
        "ProductSeatCode" AS "Ticket Type",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
            ELSE round("ProductPrice", 2)
        END AS "Gross",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
            ELSE round("ProductPrice" / 1.093, 2)
        END AS "Net",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
            ELSE round("ProductPrice", 2) - round("ProductPrice" / 1.093, 2)
        END AS "Tax",
        CASE
            WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0
            WHEN "ProductPrice" > 0::numeric THEN 1
            ELSE 0
        END AS "Sold",
        CASE
            WHEN "Status"::text = 'refunded' THEN 1
            ELSE 0
        END AS "Refunded",
        0 AS "Open",
        1 AS "Close"
    FROM "QRCodeProduct"
    WHERE "ProductType"::text = 'Movie'
      AND "ProductDate" IS NOT NULL
      AND "ProductDate"::date = p_report_date;
$fn$;
$sql$, theatre_id::integer, theatre_name, film_code_prefix);
END
$migration$;


-- ============================================================
-- 2026-10-25: add OWNER_BCC_EMAIL
-- ============================================================
-- Found while writing getSquareOrders' test suite: sendEmailWithMultipleAttachments
-- (the one live function that sends every ticket confirmation email, for
-- every client) had the first venue's own inbox hardcoded as an
-- unconditional BCC + SES Destination on every send, and as the fallback
-- recipient for a walk-up/cash sale with no captured buyer email -- a
-- cross-client PII leak the moment a second client goes live (every other
-- venue's customer emails + QR ticket PDFs would've been copied to
-- that venue's inbox). Replaced with this new per-client,
-- user-settable (via QRScanner's Client Settings page) config key, unset
-- by default; every client starts unset. A venue that wants a copy of
-- every ticket email sets its own address in Client Settings.
BEGIN;

UPDATE public."Client"
SET "configuration" = "configuration"::jsonb || '{"OWNER_BCC_EMAIL": ""}'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE NOT ("configuration"::jsonb ? 'OWNER_BCC_EMAIL');

UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  '[
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_URL",
    "SQUARE_LOCATION_ID",
    "DISTRIBUTOR_NAME",
    "EVENT_TYPE",
    "EVENT_LOCATIONS",
    "EVENT_DESCRIPTORS",
    "USERS_NAMES",
    "GOOGLE_SERVICE_ACCOUNT_KEY",
    "CINEMA_CALENDAR_ID",
    "EVENT_CALENDAR_ID",
    "ANTHROPIC_API_KEY",
    "FTP1_HOST",
    "FTP1_PASSWORD",
    "FTP1_PORT",
    "FTP1_REMOTE_PATH",
    "FTP1_TYPE",
    "FTP1_USER",
    "FTP2_HOST",
    "FTP2_PASSWORD",
    "FTP2_PORT",
    "FTP2_REMOTE_PATH",
    "FTP2_TYPE",
    "FTP2_USER",
    "FTP3_HOST",
    "FTP3_PASSWORD",
    "FTP3_PORT",
    "FTP3_REMOTE_PATH",
    "FTP3_TYPE",
    "FTP3_USER",
    "USE_FTP",
    "THEATER_ID",
    "THEATER_NAME",
    "WEB_HEADER_COMPANY",
    "LOGO_FILE",
    "EBOR_THEATRE_NO",
    "FILM_CODE_PREFIX",
    "MODIFIER_NAME_FILTER",
    "TARGET_CATEGORIES",
    "SEND_SMS",
    "PASSWORD_RESET_SECRET",
    "ECOMMERCE_SITE_URL",
    "SMS_CAMPAIGN_ID",
    "SMS_ORIGINATION_NUMBER",
    "SMS_SENDER_BRAND",
    "SMS_OPT_OUT_LIST_NAME",
    "SMS_SPEND_LIMIT_PER_5MIN",
    "SMS_LOG_RETENTION_DAYS",
    "BAD_SHOWTIME_SNS_TOPIC_ARN",
    "INDIETIX_PRIVACY_URL",
    "INDIETIX_TERMS_URL",
    "MARKETING_ENGINE_ENABLED",
    "DIGEST_ENABLED",
    "DIGEST_DAY_OF_WEEK",
    "DIGEST_TIME",
    "DIGEST_CHANNELS",
    "MARKETING_SES_CONFIGURATION_SET",
    "SHARE_NUDGE_ENABLED",
    "OWNER_BCC_EMAIL",
    "META_PAGE_ACCESS_TOKEN",
    "META_PAGE_ID",
    "META_IG_BUSINESS_ID",
    "TIKTOK_ACCESS_TOKEN",
    "TIKTOK_REFRESH_TOKEN",
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "TIKTOK_PRIVACY_LEVEL"
  ]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP;

COMMIT;

-- ============================================================
-- 2026-10-26: add SkeletonKey lifetime-use cap + expiration date
-- ============================================================
-- SkeletonKey previously only supported a per-day rate limit
-- (maxUsesPerDay). Adds two more independent caps: maxTotalUses (a
-- lifetime ceiling checked against the existing totalUses counter) and
-- expiresAt (a calendar date after which the key stops working). Both
-- nullable so every existing skeleton key is unaffected -- NULL means
-- unlimited / never expires, same convention as maxUsesPerDay already
-- uses.
BEGIN;

ALTER TABLE "SkeletonKey" ADD COLUMN IF NOT EXISTS "maxTotalUses" INTEGER;
ALTER TABLE "SkeletonKey" ADD COLUMN IF NOT EXISTS "expiresAt" DATE;

COMMIT;

-- ============================================================
-- 2026-10-29: public API v1 -- ApiKey + ApiIdempotency
-- ============================================================
-- Per-venue API keys (only the SHA-256 of each key is stored) and a
-- small idempotency table for /v1 check-ins. Must match
-- createDatabaseObjects in src/index.js.
BEGIN;

CREATE TABLE IF NOT EXISTS public."ApiKey" (
  "ID" SERIAL PRIMARY KEY,
  "Name" VARCHAR(100) NOT NULL,
  "KeyPrefix" VARCHAR(40) NOT NULL,
  "KeyHash" CHAR(64) NOT NULL,
  "Scopes" JSONB NOT NULL DEFAULT '[]',
  "DataFilter" JSONB,
  "CreatedAt" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "LastUsedAt" TIMESTAMP WITHOUT TIME ZONE,
  "RevokedAt" TIMESTAMP WITHOUT TIME ZONE,
  "RateWindowStart" TIMESTAMP WITHOUT TIME ZONE,
  "RateWindowCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ApiKey_KeyHash_key" UNIQUE ("KeyHash")
);

CREATE TABLE IF NOT EXISTS public."ApiIdempotency" (
  "ApiKeyID" INTEGER NOT NULL,
  "IdempotencyKey" VARCHAR(100) NOT NULL,
  "ResponseStatus" INTEGER NOT NULL,
  "ResponseBody" JSONB NOT NULL,
  "CreatedAt" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("ApiKeyID", "IdempotencyKey")
);

COMMIT;
