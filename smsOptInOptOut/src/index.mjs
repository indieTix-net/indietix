// handleInboundSms.mjs
//
// Inbound SMS handler for IndieTix.
//
// ROUTING MODEL: Each client has their OWN 10DLC campaign and OWN
// origination number. The inbound event's destinationNumber uniquely
// identifies which client the message is for -- no fan-out searching
// across all client databases. This is share-nothing multi-tenancy:
// a customer opted in for Client A texting STOP to Client A's number
// only revokes their consent at Client A, not at any other client
// where their phone also happens to be opted in.
//
// SUBSCRIBED TO: the SNS topic that AWS End User Messaging publishes
// inbound SMS events to. All client origination numbers can publish
// to the same shared topic; the Lambda routes by destinationNumber.
//
// SCOPE: This Lambda's job is to keep each client's SmsConsent table
// in sync with what AWS End User Messaging is doing. It does NOT send
// reply messages itself. Reply messages (STOP confirmation, HELP text,
// START confirmation) are configured as AWS "keyword response" messages
// on each client's phone number, and AWS sends them automatically. Two
// reasons for this split:
//
//   1. AWS's opt-out list is enforced at the SendTextMessage API level.
//      Once someone texts STOP, AWS adds them to the opt-out list
//      immediately. Any subsequent send from us fails with a
//      ConflictException. AWS's built-in keyword response bypasses this
//      restriction; ours can't.
//   2. Configuring keyword responses in AWS is a one-time console/CLI
//      op per client and gives us the same customization we'd have in
//      code. No reason to reinvent it.
//
// SETUP REQUIRED per client before this Lambda is useful for them:
//   - A registered 10DLC campaign (per-client, so tenants stay isolated
//     from each other's compliance issues)
//   - An origination number provisioned in AWS End User Messaging and
//     associated with that client's campaign
//   - Two-way SMS enabled on the number's pool, publishing to the
//     shared inbound SNS topic
//   - Keyword responses (STOP/HELP/START) configured on the number
//   - A per-client opt-out list (recommended) so opt-outs don't leak
//     between clients
//   - Client config populated with SMS_CAMPAIGN_ID, SMS_ORIGINATION_NUMBER,
//     and optionally SMS_OPT_OUT_LIST_NAME
//
// The Lambda auto-discovers new clients on each invocation from
// Secrets Manager -- no redeploy needed when a new client comes online,
// as long as their SMS_ORIGINATION_NUMBER is populated in their config.
//
// NON-GOAL: caching. Inbound SMS is low-volume; the discovery + config
// load cost per invocation is fine. Add TTL caching if inbound volume
// grows enough to matter.

import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import {
    PinpointSMSVoiceV2Client,
    DeleteOptedOutNumberCommand
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import pg from 'pg';

import { normalizeToE164 } from 'sms-utils';

const { Pool } = pg;

// ============================================================================
// CONFIG
// ============================================================================

// Optional override for testing/dev. When set, discovery is skipped and this
// exact list is used. Leave unset in prod so onboarding a new client is
// zero-touch for this Lambda.
const CLIENT_IDS_OVERRIDE = (process.env.CLIENT_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Prefix under which each client's DB credentials live in Secrets Manager.
// Full path: {SECRETS_PREFIX}{clientId}/credentials
const SECRETS_PREFIX = 'indieTix/rds/clients/';

// Client IDs are Square merchant IDs: exactly 13 characters, uppercase
// alphanumeric (e.g., "M5E5N7KAHZA7Q"). Anything under SECRETS_PREFIX that
// doesn't match this shape is treated as an admin/system credential and
// excluded from discovery -- for example the "indietix" superuser credential
// used by the setup Lambda. Filtering by shape rather than an explicit
// name-list is forward-compatible: future admin creds (e.g. "backup" or
// "readonly") are automatically excluded without a code change.
const CLIENT_ID_PATTERN = /^[A-Z0-9]{13}$/;

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
const smsVoiceClient = new PinpointSMSVoiceV2Client({ region: process.env.AWS_REGION });

// ============================================================================
// KEYWORD DETECTION
// ============================================================================
// AWS's own required opt-out keyword list (from docs) plus a few "friendly"
// variants. We match on first-word-only so "STOP please" and "help me"
// still classify correctly.

const STOP_KEYWORDS  = new Set([
    'STOP', 'STOPALL', 'END', 'QUIT', 'CANCEL', 'UNSUBSCRIBE',
    'OPTOUT', 'OPT-OUT', 'REMOVE', 'ARRET', 'TD'
]);
const HELP_KEYWORDS  = new Set(['HELP', 'INFO', 'AIDE']);
const START_KEYWORDS = new Set(['START', 'UNSTOP', 'YES', 'SUBSCRIBE']);

function parseIntent({ messageKeyword, messageBody }) {
    // Prefer AWS's carrier-detected keyword when present -- it's already
    // been normalized against the registered keyword list.
    const raw = ((messageKeyword || messageBody) || '').trim().toUpperCase();
    const firstWord = raw.split(/\s+/)[0];
    if (STOP_KEYWORDS.has(firstWord))  return 'stop';
    if (HELP_KEYWORDS.has(firstWord))  return 'help';
    if (START_KEYWORDS.has(firstWord)) return 'start';
    return 'unknown';
}

// ============================================================================
// DB HELPERS (mirror getSquareOrders.mjs conventions)
// ============================================================================

async function getDatabaseCredentials(clientId) {
    const secretName = `indieTix/rds/clients/${clientId}/credentials`;
    const response = await secretsClient.send(new GetSecretValueCommand({
        SecretId: secretName,
        VersionStage: 'AWSCURRENT'
    }));
    return JSON.parse(response.SecretString);
}

async function createClientPool(clientId) {
    if (!/^[A-Za-z0-9]+$/.test(clientId)) {
        console.error(`Invalid clientId format: ${clientId}`);
        return null;
    }
    try {
        const creds = await getDatabaseCredentials(clientId);
        const pool = new Pool({
            host: creds.host,
            port: parseInt(creds.port || '5432'),
            database: clientId,
            user: creds.username,
            password: creds.password,
            ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false,
            idleTimeoutMillis: 10000,
            max: 4
        });
        // Test connection before returning
        const client = await pool.connect();
        client.release();
        return pool;
    } catch (e) {
        console.error(`Failed to create pool for ${clientId}:`, e);
        return null;
    }
}

async function getClientConfiguration(pool, clientId) {
    const result = await pool.query(
        `SELECT "configuration" FROM "Client" WHERE "clientID" = $1`,
        [clientId]
    );
    if (result.rows.length === 0) throw new Error(`No config for ${clientId}`);
    return result.rows[0].configuration;
}

// ============================================================================
// CLIENT DISCOVERY
// ============================================================================
// Every client's DB credentials live at indieTix/rds/clients/{clientId}/credentials
// in Secrets Manager. Listing that prefix gives us the current active client
// set for free, no separate registry to maintain. Onboarding a new client
// = the setup lambda creates the secret = this Lambda sees it on next invoke.

/**
 * Discover all currently-configured client IDs from Secrets Manager.
 *
 * If CLIENT_IDS env var override is set, returns that list directly (for
 * dev/test). Otherwise, lists all secrets under SECRETS_PREFIX, extracts
 * clientId from each name, and returns the deduplicated set.
 *
 * Called on every invocation; no caching, since inbound SMS is
 * low-frequency and stale client lists could cause missed opt-outs
 * (regulatory risk). The ~100ms API call is worth the freshness.
 */
async function discoverClientIds() {
    if (CLIENT_IDS_OVERRIDE.length > 0) {
        console.log(`Using CLIENT_IDS override: ${CLIENT_IDS_OVERRIDE.join(', ')}`);
        return CLIENT_IDS_OVERRIDE;
    }

    const clientIds = [];
    let nextToken = undefined;

    do {
        const response = await secretsClient.send(new ListSecretsCommand({
            Filters: [{ Key: 'name', Values: [SECRETS_PREFIX] }],
            MaxResults: 100,
            NextToken: nextToken
        }));

        for (const secret of (response.SecretList || [])) {
            // Match: indieTix/rds/clients/{clientId}/credentials
            const match = (secret.Name || '').match(
                /^indieTix\/rds\/clients\/([A-Za-z0-9_-]+)\/credentials$/
            );
            if (!match) continue;
            const candidateId = match[1];
            if (!CLIENT_ID_PATTERN.test(candidateId)) {
                // Not a real client ID -- most likely an admin/system credential
                // (e.g. "indietix" superuser). Skip silently at info level.
                console.log(`Skipping non-client secret: ${candidateId} (does not match Square merchant ID shape)`);
                continue;
            }
            clientIds.push(candidateId);
        }

        nextToken = response.NextToken;
    } while (nextToken);

    // Dedupe just in case (Filters key='name' does prefix match; shouldn't
    // return dupes but belt-and-suspenders).
    const unique = Array.from(new Set(clientIds));
    console.log(`Discovered ${unique.length} client(s): ${unique.join(', ')}`);
    return unique;
}

// ============================================================================
// CLIENT ROUTING BY DESTINATION NUMBER
// ============================================================================

/**
 * Find which client owns the origination number that received this inbound
 * SMS. Loads each client's configuration and matches against the
 * SMS_ORIGINATION_NUMBER field, returning the first (and only expected)
 * match plus its open pool + config.
 *
 * With per-client campaigns, exactly one client should own any given
 * destination number. If we find zero, either onboarding is incomplete
 * (SMS_ORIGINATION_NUMBER not set) or the SNS routing is misconfigured.
 * If we find multiple, that's a config bug worth logging.
 *
 * The caller closes match.pool via match.pool.end() when done. Pools of
 * non-matching clients are closed internally before returning.
 */
async function findClientByDestinationNumber(destinationNumber, clientIds) {
    let match = null;
    for (const clientId of clientIds) {
        const pool = await createClientPool(clientId);
        if (!pool) continue;
        try {
            const config = await getClientConfiguration(pool, clientId);
            if (config.SMS_ORIGINATION_NUMBER === destinationNumber) {
                if (match) {
                    // Two clients claim the same origination number. Keep
                    // the first (already-open) match, log the collision so
                    // it can be fixed, and close this duplicate's pool.
                    console.error(`Config collision: both ${match.clientId} and ${clientId} have SMS_ORIGINATION_NUMBER=${destinationNumber}`);
                    await pool.end();
                    continue;
                }
                match = { clientId, pool, config };
            } else {
                await pool.end();
            }
        } catch (e) {
            console.error(`Error checking ${clientId} for destination ${destinationNumber}:`, e);
            try { await pool.end(); } catch (_) {}
        }
    }
    return match;
}

/**
 * For an already-routed client, look up the most recent SmsConsent row
 * for this phone. Returns null if the customer has no consent history
 * with this client (rare edge case: they text STOP without ever having
 * opted in; AWS still opts them out and sends the confirmation).
 */
async function findConsentInClient(pool, normalizedPhone) {
    const result = await pool.query(
        `SELECT "ID", "Status", "RevokedAt", "ConsentTimestamp", "CustomerID"
         FROM "SmsConsent"
         WHERE "PhoneNumber" = $1
         ORDER BY "ConsentTimestamp" DESC
         LIMIT 1`,
        [normalizedPhone]
    );
    return result.rows[0] || null;
}

// ============================================================================
// ACTION HANDLERS
// ============================================================================
// Each handler updates our SmsConsent table to reflect what just happened.
// None of them send SMS -- AWS End User Messaging's configured keyword
// responses take care of the reply text. This split is deliberate; see the
// file header for why.

/**
 * STOP handling: mark any active consent for this phone as revoked.
 * Idempotent -- if they're already revoked, no-op.
 * AWS has already added them to its opt-out list by the time we run.
 */
async function handleStop({ pool, normalizedPhone, mostRecentConsent }) {
    if (mostRecentConsent.Status !== 'active') {
        console.log(`STOP for ${normalizedPhone}: no active consent to revoke (current status: ${mostRecentConsent.Status})`);
        return { revoked: 0 };
    }
    const result = await pool.query(
        `UPDATE "SmsConsent"
         SET "Status" = 'revoked', "RevokedAt" = CURRENT_TIMESTAMP
         WHERE "PhoneNumber" = $1 AND "Status" = 'active'
         RETURNING "ID"`,
        [normalizedPhone]
    );
    console.log(`STOP for ${normalizedPhone}: revoked ${result.rows.length} active consent row(s)`);
    return { revoked: result.rows.length };
}

/**
 * START handling: insert a new active consent row, linked back to the
 * most recent (revoked) row via PreviousConsentID for audit continuity.
 * If they're already active, no-op on the DB but still call the AWS
 * opt-out list removal in case they somehow got on it.
 */
async function handleStart({ pool, normalizedPhone, mostRecentConsent, clientConfig }) {
    if (mostRecentConsent.Status === 'active') {
        console.log(`START for ${normalizedPhone}: already active, no INSERT needed`);
    } else {
        await pool.query(
            `INSERT INTO "SmsConsent" (
                "CustomerID", "PhoneNumber", "Status", "OptInMethod",
                "ConsentText", "ConsentURL", "PreviousConsentID",
                "CampaignID", "ConsentTimestamp", "CreatedDate"
             ) VALUES (
                $1, $2, 'active', 'sms_start',
                'User texted START keyword to resubscribe',
                NULL, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             )`,
            [
                mostRecentConsent.CustomerID,
                normalizedPhone,
                mostRecentConsent.ID,
                clientConfig.SMS_CAMPAIGN_ID || null
            ]
        );
        console.log(`START for ${normalizedPhone}: inserted new active consent (superseding ${mostRecentConsent.ID})`);
    }

    // Defensive: AWS's opt-in keyword action should have already removed
    // them from the opt-out list, but this catches edge cases (misconfig,
    // manual list add, etc.). Safe no-op if not on list.
    await removeFromAwsOptOutList(normalizedPhone, clientConfig.SMS_OPT_OUT_LIST_NAME);
}

async function removeFromAwsOptOutList(normalizedPhone, optOutListName) {
    if (!optOutListName) {
        console.log(`No SMS_OPT_OUT_LIST_NAME configured for client; skipping opt-out list removal for ${normalizedPhone}`);
        return;
    }
    try {
        await smsVoiceClient.send(new DeleteOptedOutNumberCommand({
            OptOutListName: optOutListName,
            OptedOutNumber: normalizedPhone
        }));
        console.log(`Removed ${normalizedPhone} from AWS opt-out list "${optOutListName}"`);
    } catch (e) {
        if (e.name === 'ResourceNotFoundException') {
            // Not on the list -- this is the expected happy path.
            return;
        }
        console.warn(`Failed to remove ${normalizedPhone} from AWS opt-out list "${optOutListName}":`, e.name || e.message);
    }
}

// ============================================================================
// EVENT PARSING
// ============================================================================
// The Lambda might be invoked from SNS directly, from SQS wrapping SNS,
// or from Pinpoint direct invocation. Handle all three formats.

function extractInboundMessages(event) {
    const messages = [];

    if (event.Records && Array.isArray(event.Records)) {
        for (const record of event.Records) {
            let payload = null;

            if (record.Sns && record.Sns.Message) {
                try {
                    payload = JSON.parse(record.Sns.Message);
                } catch (e) {
                    console.error('Failed to parse SNS message body:', e);
                }
            } else if (record.body) {
                try {
                    const parsed = JSON.parse(record.body);
                    // SQS body might wrap an SNS envelope (SNS -> SQS) or
                    // might be the raw payload (direct SQS).
                    if (parsed.Message && typeof parsed.Message === 'string') {
                        payload = JSON.parse(parsed.Message);
                    } else {
                        payload = parsed;
                    }
                } catch (e) {
                    console.error('Failed to parse SQS body:', e);
                }
            }

            if (payload) messages.push(payload);
        }
    } else if (event.originationNumber) {
        // Direct invocation
        messages.push(event);
    }

    return messages;
}

// ============================================================================
// MAIN
// ============================================================================

// Exported for this repo's own tests -- purely additive, doesn't change
// handler's own behavior. Lets tests exercise the pure logic (parseIntent,
// extractInboundMessages) and the DB/AWS-touching pieces individually
// against a real test database / mocked AWS clients, instead of only
// black-box through handler().
export {
    parseIntent,
    extractInboundMessages,
    discoverClientIds,
    findClientByDestinationNumber,
    findConsentInClient,
    handleStop,
    handleStart,
    removeFromAwsOptOutList,
    processInboundMessage
};

export const handler = async (event) => {
    console.log('Inbound SMS event:', JSON.stringify(event));

    // Discover the current client set once per invocation. If we can't
    // reach Secrets Manager or there are literally no clients yet, we
    // can't do anything useful -- log and bail.
    let clientIds;
    try {
        clientIds = await discoverClientIds();
    } catch (e) {
        console.error('Client discovery failed; cannot process inbound:', e);
        return { statusCode: 500, error: 'client discovery failed' };
    }
    if (clientIds.length === 0) {
        console.error('No clients discovered; cannot process inbound. Exiting.');
        return { statusCode: 500, error: 'no clients configured' };
    }

    const messages = extractInboundMessages(event);
    console.log(`Extracted ${messages.length} inbound message(s) from event`);

    // Process one at a time. Each is independent; a failure on one
    // shouldn't stop the others. AWS handles retry/DLQ at the SNS/SQS
    // level.
    for (const msg of messages) {
        try {
            await processInboundMessage(msg, clientIds);
        } catch (e) {
            console.error('Error processing inbound message:', e);
        }
    }

    return { statusCode: 200 };
};

async function processInboundMessage(msg, clientIds) {
    const {
        originationNumber,
        destinationNumber,
        messageKeyword,
        messageBody,
        inboundMessageId
    } = msg;

    console.log(`Inbound: from=${originationNumber} to=${destinationNumber} keyword=${messageKeyword} body="${messageBody}" id=${inboundMessageId}`);

    if (!destinationNumber) {
        console.warn('Missing destinationNumber on inbound event; cannot route. Skipping.');
        return;
    }

    const normalizedPhone = normalizeToE164(originationNumber);
    if (!normalizedPhone) {
        console.warn(`Could not normalize origination number "${originationNumber}". Skipping.`);
        return;
    }

    const intent = parseIntent({ messageKeyword, messageBody });
    console.log(`Intent for from=${normalizedPhone} to=${destinationNumber}: ${intent}`);

    if (intent === 'unknown') {
        // Best practice: don't reply to unrecognized inbound. Just log.
        return;
    }

    // Route to the client that owns this destination number.
    const match = await findClientByDestinationNumber(destinationNumber, clientIds);
    if (!match) {
        // No client claims this number. Either onboarding is incomplete
        // (SMS_ORIGINATION_NUMBER not set on any client's config) or the
        // SNS routing is bringing in traffic for a number we don't own.
        // AWS will still handle its default reply and opt-out list update
        // regardless.
        console.warn(`No client owns destination ${destinationNumber}; nothing to update in any DB. AWS handles the reply/opt-out.`);
        return;
    }

    console.log(`Routed to client ${match.clientId} (owner of ${destinationNumber})`);

    try {
        const clientConfig = match.config;

        if (intent === 'help') {
            // HELP doesn't affect consent state -- AWS sends the configured
            // HELP response and we just log for observability.
            console.log(`HELP received from ${normalizedPhone} on ${match.clientId}; AWS handles the reply`);
            return;
        }

        // STOP or START: look up the consent record within THIS client only.
        const mostRecentConsent = await findConsentInClient(match.pool, normalizedPhone);

        if (!mostRecentConsent) {
            // No consent record for this phone in this client's DB. Rare
            // -- means someone's texting STOP/START to our number without
            // ever having opted in. For STOP, AWS still handles the reply
            // + opt-out list; no DB update needed. For START, do the
            // defensive opt-out list removal in case they somehow got on
            // it -- but no SmsConsent row to insert.
            console.log(`No consent record for ${normalizedPhone} on ${match.clientId}; intent=${intent}`);
            if (intent === 'start') {
                await removeFromAwsOptOutList(normalizedPhone, clientConfig.SMS_OPT_OUT_LIST_NAME);
            }
            return;
        }

        if (intent === 'stop') {
            await handleStop({
                pool: match.pool,
                normalizedPhone: normalizedPhone,
                mostRecentConsent: mostRecentConsent
            });
        } else if (intent === 'start') {
            await handleStart({
                pool: match.pool,
                normalizedPhone: normalizedPhone,
                mostRecentConsent: mostRecentConsent,
                clientConfig: clientConfig
            });
        }
    } finally {
        try { await match.pool.end(); } catch (_) {}
    }
}
