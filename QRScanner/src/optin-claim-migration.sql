-- Token-scoped opt-in hardening.
--
-- Adds OptInClaimedByPhone to Order. The rule: once a token has been used
-- to opt in a specific phone, that token is bound to that phone forever.
-- Subsequent POSTs with the same token but a different phone are rejected
-- with 409 -- eliminates the SMS-amplification vector where someone with
-- a leaked opt-in URL could burn one token to spam many random phones.
--
-- The claim is set atomically at consent time via:
--   UPDATE "Order"
--   SET "OptInClaimedByPhone" = $1
--   WHERE "ID" = $2
--     AND ("OptInClaimedByPhone" IS NULL OR "OptInClaimedByPhone" = $1)
--   RETURNING "ID"
-- Zero rows returned = someone else already claimed this token with a
-- different phone. Race-safe by construction.
--
-- Same phone re-submitting (idempotent re-send) matches the second WHERE
-- branch, so the update is a no-op / self-match and returns the row.
-- Legit revoke-then-resubscribe from the same phone also works fine.
--
-- Safe to run multiple times; safe to run before or after the app code
-- is deployed. If the column is missing, the app throws on the UPDATE.
-- If the app hasn't been deployed yet, the column just sits empty.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "OptInClaimedByPhone" VARCHAR(20);

-- No index needed: we only ever check this column on a row we already
-- looked up by OptInToken, so the existing index on OptInToken is enough.

-- === Also update the client-setup script ===
-- For future clients, add this to the Order table's ADD COLUMN block in
-- the setup lambda's index.js, alongside the existing OptInToken/CustomerID
-- lines. Otherwise new client DBs won't have the column and their opt-in
-- POST will fail.
