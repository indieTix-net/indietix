// utils/sms.mjs
//
// Centralized SMS send module for IndieTix.
//
// Every SMS that goes out -- ticket delivery, day-before reminder, door-open
// reminder, STOP/HELP auto-replies -- goes through sendSms(). The function
// verifies active consent against SmsConsent before calling AWS's
// SendTextMessage, with one explicit exception for auto-replies to inbound
// STOP/HELP messages (where the carrier has already established that the
// recipient initiated the conversation, so consent semantics don't apply).
//
// This module is the only place in the codebase that should import
// @aws-sdk/client-pinpoint-sms-voice-v2. If you find yourself reaching for
// SendTextMessageCommand directly somewhere else, stop and route through
// here instead.

import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { normalizeToE164 } from './phone.mjs';

const smsClient = new PinpointSMSVoiceV2Client({ region: 'us-east-2' });

// Default per-client spend limit. Blocks sends when the client's DB has more
// than this many successful SMS in the last 5 minutes. A busy show can
// legitimately burst 100-200 opt-ins in a few minutes if a sellout happens
// with everyone opting in for texts, so 300 leaves headroom while still
// catching runaway situations (bug, attack, misconfig). Overridable per
// client via clientConfig.SMS_SPEND_LIMIT_PER_5MIN.
const DEFAULT_SPEND_LIMIT_PER_5MIN = 300;

// SmsOutboundLog retention. Pruning runs probabilistically (~1% of successful
// sends) to keep the table bounded without new infrastructure. At Liberty
// Hall's expected volume, 30 days = ~7 MB. Overridable per client via
// clientConfig.SMS_LOG_RETENTION_DAYS. Set 0 or unset to fall back to default.
const DEFAULT_LOG_RETENTION_DAYS = 30;
const PRUNE_PROBABILITY = 0.01;

/**
 * Result shape returned by sendSms(). Always has `sent` (boolean) and
 * `reason` (short string). On successful send, also has `messageId`.
 *
 * Reasons:
 *   'sent'                    -- success
 *   'sms_disabled'            -- client config has SEND_SMS != "true"
 *   'invalid_phone'           -- couldn't normalize to E.164
 *   'no_consent'              -- no active SmsConsent row for this number
 *   'missing_origination'     -- client config missing SMS_ORIGINATION_NUMBER
 *   'spend_limit_exceeded'    -- circuit breaker: too many sends in last 5 min
 *   'aws_error'               -- AWS API call failed; check `error` field
 */

/**
 * Send an SMS message. Verifies consent before sending unless explicitly
 * bypassed (only for inbound auto-replies).
 *
 * @param {Object} opts
 * @param {string} opts.toPhone           Recipient phone (any format; will be normalized)
 * @param {string} opts.body              Message body (already includes brand prefix and STOP/HELP footer if appropriate)
 * @param {Object} opts.clientConfig      Client configuration object from Client.configuration
 * @param {Object} opts.pool              PostgreSQL connection pool for consent check
 * @param {boolean} [opts.bypassConsentCheck=false]  ONLY for STOP/HELP auto-replies. Never set this from feature code.
 * @returns {Promise<{sent: boolean, reason: string, messageId?: string, error?: string}>}
 */
export async function sendSms({ toPhone, body, clientConfig, pool, bypassConsentCheck = false }) {
  // 1. Master kill switch -- if SEND_SMS isn't explicitly "true" we don't send.
  //    Default for new clients is "false" so SMS stays off until a 10DLC
  //    campaign is approved and the client flips this on.
  const smsEnabled = clientConfig.SEND_SMS === true || clientConfig.SEND_SMS === 'true';
  if (!smsEnabled) {
    console.log('sendSms: SMS disabled for this client (SEND_SMS != "true"); skipping');
    return { sent: false, reason: 'sms_disabled' };
  }

  // 2. Origination number must be configured. Without it AWS has nothing
  //    to send FROM. New clients won't have one until a 10DLC number is
  //    provisioned in AWS End User Messaging.
  const originationNumber = clientConfig.SMS_ORIGINATION_NUMBER;
  if (!originationNumber) {
    console.error('sendSms: SMS_ORIGINATION_NUMBER not configured for client');
    return { sent: false, reason: 'missing_origination' };
  }

  // 3. Normalize destination phone. Anything that fails to parse to E.164
  //    is rejected -- carriers will reject malformed numbers anyway, but
  //    catching it here avoids the round-trip and the AWS spend.
  const normalizedPhone = normalizeToE164(toPhone);
  if (!normalizedPhone) {
    console.warn(`sendSms: could not normalize phone "${toPhone}" to E.164; skipping`);
    return { sent: false, reason: 'invalid_phone' };
  }

  // 4. Consent gate -- unless explicitly bypassed (only for STOP/HELP auto-replies),
  //    the recipient must have an active SmsConsent row. Belt-and-suspenders: even
  //    if a future caller forgets the consent check, this catches it.
  if (!bypassConsentCheck) {
    const consentResult = await pool.query(
      `SELECT "ID" FROM "SmsConsent"
       WHERE "PhoneNumber" = $1 AND "Status" = 'active'
       LIMIT 1`,
      [normalizedPhone]
    );
    if (consentResult.rows.length === 0) {
      console.warn(`sendSms: no active consent for ${normalizedPhone}; refusing to send`);
      return { sent: false, reason: 'no_consent' };
    }
  }

  // 5. Spend circuit breaker. Counts successful sends in the last 5 minutes
  //    from this client's SmsOutboundLog. Fails-open on infrastructure errors:
  //    if the count query fails, log the failure and proceed. The rationale
  //    is that if the DB is broken enough that this query fails, the consent
  //    check at step 4 would have failed too and we wouldn't be here -- so
  //    a failure here is a rare edge case, not a normal DB outage.
  const configLimit = Number(clientConfig.SMS_SPEND_LIMIT_PER_5MIN);
  const spendLimit = Number.isFinite(configLimit) && configLimit > 0
    ? configLimit
    : DEFAULT_SPEND_LIMIT_PER_5MIN;
  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM "SmsOutboundLog"
       WHERE "SentAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'`
    );
    const recentCount = countResult.rows[0].cnt;
    if (recentCount >= spendLimit) {
      console.error(
        `sendSms: CIRCUIT BREAKER TRIPPED - ${recentCount} sends in last 5 min ` +
        `exceeds limit ${spendLimit}. Refusing to send to ${normalizedPhone}. ` +
        `If this is expected traffic, raise SMS_SPEND_LIMIT_PER_5MIN in client config.`
      );
      return { sent: false, reason: 'spend_limit_exceeded' };
    }
  } catch (checkErr) {
    console.warn(`sendSms: spend limit check query failed; proceeding without limit check:`, checkErr.message);
  }

  // 6. Send via AWS End User Messaging (Pinpoint SMS Voice v2).
  //    MessageType=TRANSACTIONAL because this campaign is registered as
  //    transactional 10DLC -- ticket delivery and event reminders, not
  //    marketing. Sending marketing-classified traffic on a transactional
  //    campaign gets the number flagged fast.
  let response;
  try {
    const cmd = new SendTextMessageCommand({
      DestinationPhoneNumber: normalizedPhone,
      OriginationIdentity: originationNumber,
      MessageBody: body,
      MessageType: 'TRANSACTIONAL'
    });
    response = await smsClient.send(cmd);
    console.log(`sendSms: sent to ${normalizedPhone}, MessageId=${response.MessageId}`);
  } catch (err) {
    console.error(`sendSms: AWS error sending to ${normalizedPhone}:`, err);
    return { sent: false, reason: 'aws_error', error: err.message };
  }

  // 7. Log the successful send to SmsOutboundLog. Feeds the circuit breaker's
  //    count query on future sends. Failure to log is non-fatal -- the SMS
  //    already went out; we just lose the audit record and the counter is
  //    slightly off for the next 5 minutes.
  try {
    await pool.query(
      `INSERT INTO "SmsOutboundLog" ("PhoneNumber", "MessageID", "BodyPreview")
       VALUES ($1, $2, $3)`,
      [normalizedPhone, response.MessageId, (body || '').substring(0, 160)]
    );
  } catch (logErr) {
    console.warn(`sendSms: failed to log outbound send to SmsOutboundLog (message was sent successfully):`, logErr.message);
  }

  // 8. Probabilistic prune. On roughly 1% of sends, delete rows older than
  //    the retention window. Keeps the table bounded without new infrastructure.
  //    When EventBridge Scheduler is set up later (for day-before/door-open
  //    reminders), migrate this to a dedicated nightly Lambda and remove
  //    this block. Non-fatal on failure.
  if (Math.random() < PRUNE_PROBABILITY) {
    const configRetention = Number(clientConfig.SMS_LOG_RETENTION_DAYS);
    const retentionDays = Number.isFinite(configRetention) && configRetention > 0
      ? configRetention
      : DEFAULT_LOG_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const pruneResult = await pool.query(
        `DELETE FROM "SmsOutboundLog" WHERE "SentAt" < $1`,
        [cutoff]
      );
      if (pruneResult.rowCount > 0) {
        console.log(`sendSms: pruned ${pruneResult.rowCount} SmsOutboundLog rows older than ${retentionDays} days`);
      }
    } catch (pruneErr) {
      console.warn(`sendSms: prune failed (non-fatal):`, pruneErr.message);
    }
  }

  return { sent: true, reason: 'sent', messageId: response.MessageId };
}

/**
 * Build the standard IndieTix message body with brand prefix and required
 * 10DLC footer. Use this for every message we originate; do NOT hand-build
 * message bodies elsewhere or you'll end up with inconsistent branding and
 * occasionally-missing STOP/HELP footers, which carriers do notice.
 *
 * Example output:
 *   IndieTix: Your ticket for Big Sonia at Liberty Hall on May 28 is ready: https://indietix.co/t/abc123
 *   Reply STOP to cancel, HELP for help. Msg&data rates may apply.
 *
 * @param {string} senderBrand  From clientConfig.SMS_SENDER_BRAND (default "IndieTix")
 * @param {string} content      The message-specific content (no prefix, no footer)
 * @returns {string} Fully formatted message body
 */
export function buildMessageBody(senderBrand, content) {
  const brand = senderBrand || 'IndieTix';
  return `${brand}: ${content}\n\nReply STOP to cancel, HELP for help. Msg&data rates may apply.`;
}
