# smsOptInOptOut

**Last Edited:** 2026-10-28

Keeps the `SmsConsent` table in every client's database in sync with AWS End User Messaging's own STOP/START/HELP handling. This Lambda doesn't send any SMS itself — AWS handles the actual keyword replies — it just makes sure the database agrees with what AWS already did.

## How it fits in

Every client's SMS origination number publishes inbound messages to **one shared SNS topic** — this is one of only two documented exceptions to IndieTix's otherwise-total per-client isolation (every other resource — database, S3 buckets, Secrets Manager entry, 10DLC campaign — is one-per-venue). This Lambda is the SNS topic's one subscriber, and its whole job is figuring out *which* client an inbound message belongs to and updating only that client's data.

```
Customer texts STOP/START/HELP
  → AWS End User Messaging auto-replies with the configured keyword response
    (and, for STOP, adds the number to that origination number's opt-out list)
  → AWS also publishes the inbound event to the shared SNS topic
    → this Lambda routes by destinationNumber to find the owning client
      → updates that client's SmsConsent table to match
```

Routing by `destinationNumber` (the venue's own origination number, which the inbound event always carries) rather than any shared identifier is what keeps STOP/START correctly scoped — a STOP to Client A's number can never touch Client B's consent records, even though both flow through the same topic.

## Why AWS handles the actual replies, not this code

AWS's opt-out enforcement happens at the `SendTextMessage` API level — once a phone number has texted STOP, any subsequent send attempt to it fails outright with `ConflictException`, regardless of what any Lambda's own logic thinks the consent state is. Fighting that by trying to intercept and reply to keywords ourselves would just be racing AWS's own enforcement. Configuring STOP/HELP/START as "keyword response messages" per number, directly in the AWS console, sidesteps that entirely — this Lambda's only remaining job is to keep the database honest about what already happened.

## Client discovery

No per-client configuration lives in this repo or its deployment. On every invocation, it lists every secret under `indieTix/rds/clients/` in Secrets Manager and filters to the ones that look like a real client ID — exactly 13 uppercase alphanumeric characters, matching Square's own merchant ID format (e.g. `M5E5N7KAHZA7Q`). Anything else under that prefix (like the shared admin/superuser credential used by client onboarding) is skipped automatically, by shape, with no explicit exclusion list to maintain. Onboard a new client and this Lambda picks it up on its very next invocation — no redeploy, no config change.

**Practical implication:** a client's `username`/clientID genuinely needs to match that 13-character pattern for this Lambda's auto-discovery to find it at all. Every real client so far has used their actual Square merchant ID as this value, which already satisfies the pattern — but it's worth knowing this isn't just a naming convention for this one Lambda, it's closer to a real constraint.

## Environment variables

| Variable | Purpose |
|---|---|
| `AWS_REGION` | Region for Secrets Manager and the Pinpoint SMS Voice v2 client |
| `CLIENT_IDS` | **Optional, dev/testing only.** A comma-separated list of client IDs to use instead of discovering them from Secrets Manager — skips the `ListSecrets` call entirely. Leave unset in production so onboarding stays zero-touch for this Lambda. |

## Non-obvious behavior worth knowing

- **`package.json`'s `"main"` field is stale** — it points at `handleInboundSms.mjs`, which doesn't exist anywhere in this repo. The real entry point is `src/index.mjs`. Don't trust `main` when wiring up or verifying a Lambda handler configuration for this function.
- **Discovery is O(N) across all clients, per invocation.** Fine at a handful of clients; past roughly ten, this should become a real lookup table (DynamoDB, or a shared Postgres routing table) instead of a full `ListSecrets` scan every time a text comes in.
- This Lambda never sends outbound SMS — it depends on the shared `sms-utils` package (Lambda layer) only for `normalizeToE164`, not for sending.

## Deploying

See the `infrastructure` repo's `deploy.sh` (`./deploy.sh deploy smsOptInOptOut`). This Lambda is subscribed to the shared inbound-SMS SNS topic as an SNS event source, not invoked directly or via API Gateway.
