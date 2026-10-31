// utils/phone.mjs
//
// Phone number normalization for SMS opt-in and delivery.
// Every phone number that touches the SMS pipeline -- DB writes, opt-in
// submissions, send-SMS lookups, inbound STOP/HELP matching -- runs through
// normalizeToE164() first. This is the only way to keep the SmsConsent
// table's unique-active-phone partial index reliable: a number stored as
// "+19135551234" and looked up as "(913) 555-1234" won't match without
// normalization, and the customer gets re-prompted for consent they already
// granted (or worse, gets a duplicate text).
//
// We support US/Canada numbers only for now. Anything else returns null;
// caller decides whether that's an error or a skip.

const US_COUNTRY_CODE = '1';

/**
 * Normalize a phone number string to E.164 format (+1XXXXXXXXXX for US/Canada).
 *
 * Accepts pretty much anything a customer might type:
 *   "(913) 555-1234"      -> "+19135551234"
 *   "913.555.1234"        -> "+19135551234"
 *   "913-555-1234"        -> "+19135551234"
 *   "9135551234"          -> "+19135551234"
 *   "19135551234"         -> "+19135551234"
 *   "+19135551234"        -> "+19135551234"
 *   "+1 (913) 555-1234"   -> "+19135551234"
 *
 * Returns null for anything that doesn't parse cleanly. Common rejections:
 *   - too few or too many digits
 *   - international numbers (not +1) -- intentional; SMS pipeline is US-only
 *   - empty/null/non-string input
 *
 * @param {string} input - Raw phone number string from any source
 * @returns {string|null} E.164 formatted number, or null if invalid
 */
export function normalizeToE164(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }

  // Strip everything except digits and a leading '+'.
  // We allow + only at position 0; mid-string + characters are noise.
  const trimmed = input.trim();
  const hasLeadingPlus = trimmed.startsWith('+');
  const digitsOnly = trimmed.replace(/\D/g, '');

  if (digitsOnly.length === 0) {
    return null;
  }

  // Three valid digit-count patterns for US/Canada numbers:
  //   10 digits           -> assume US, prepend "1"
  //   11 digits starting with "1" -> already has country code
  //   anything else       -> reject
  let normalizedDigits;
  if (digitsOnly.length === 10) {
    normalizedDigits = US_COUNTRY_CODE + digitsOnly;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith(US_COUNTRY_CODE)) {
    normalizedDigits = digitsOnly;
  } else {
    // If they typed +44... or +52... or any 12+ digit string, we don't want
    // to silently coerce it to a US number. Reject and let the caller decide.
    return null;
  }

  // Final sanity check: NANP area codes can't start with 0 or 1.
  // Catches typos like "0135551234" that would otherwise look valid.
  const areaCode = normalizedDigits.substring(1, 4);
  if (areaCode.startsWith('0') || areaCode.startsWith('1')) {
    return null;
  }

  return '+' + normalizedDigits;
}

/**
 * Pretty-print an E.164 number for display in UI / SMS / email.
 *   "+19135551234"   -> "(913) 555-1234"
 *
 * Returns the input as-is if it doesn't look like a US E.164 number;
 * never returns null or throws so it's safe to use in templates.
 *
 * @param {string} e164 - E.164 formatted phone number
 * @returns {string} Pretty-formatted display string
 */
export function formatForDisplay(e164) {
  if (!e164 || typeof e164 !== 'string') {
    return '';
  }
  // Expecting "+1XXXXXXXXXX" -- 12 chars total
  if (e164.length !== 12 || !e164.startsWith('+1')) {
    return e164;
  }
  const area = e164.substring(2, 5);
  const prefix = e164.substring(5, 8);
  const line = e164.substring(8, 12);
  return `(${area}) ${prefix}-${line}`;
}

/**
 * Mask an E.164 number for "we'll text (xxx) xxx-1234" UI confirmations
 * where you want the user to confirm the number without exposing it fully
 * (e.g. for shoulder-surfing privacy on a shared device).
 *
 * @param {string} e164 - E.164 formatted phone number
 * @returns {string} Masked string, e.g. "(xxx) xxx-1234"
 */
export function maskForDisplay(e164) {
  if (!e164 || typeof e164 !== 'string' || e164.length !== 12 || !e164.startsWith('+1')) {
    return '';
  }
  const last4 = e164.substring(8, 12);
  return `(xxx) xxx-${last4}`;
}
