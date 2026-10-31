-- Add new SMS keys to Liberty Hall's configuration
UPDATE public."Client"
SET "configuration" = "configuration"::jsonb 
  || '{
    "SMS_CAMPAIGN_ID": "",
    "SMS_ORIGINATION_NUMBER": "",
    "SMS_SENDER_BRAND": "IndieTix",
    "INDIETIX_PRIVACY_URL": "https://indietix.com/privacy",
    "INDIETIX_TERMS_URL": "https://indietix.com/terms"
  }'::jsonb,
  "updatedDate" = CURRENT_TIMESTAMP
WHERE "clientID" = 'M5E5N7KAHZA7Q';

-- Fix Liberty Hall's SQL_QUERY to point to the new function
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{SQL_QUERY}',
  '"SELECT * FROM get_bdor_grouped_for_date($1, $2, $3)"'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP
WHERE "clientID" = 'M5E5N7KAHZA7Q';

-- Add new keys to Liberty Hall's USER_DEFINABLE list
UPDATE public."Client"
SET "configuration" = jsonb_set(
  "configuration"::jsonb,
  '{USER_DEFINABLE}',
  ("configuration"::jsonb->'USER_DEFINABLE') 
    || '["SMS_CAMPAIGN_ID","SMS_ORIGINATION_NUMBER","SMS_SENDER_BRAND","INDIETIX_PRIVACY_URL","INDIETIX_TERMS_URL"]'::jsonb
),
  "updatedDate" = CURRENT_TIMESTAMP
WHERE "clientID" = 'M5E5N7KAHZA7Q';
