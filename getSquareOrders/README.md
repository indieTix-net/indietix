# getSquareOrders

**Last Edited:** 2026-10-28

The order-to-ticket pipeline: a Square order comes in, QR-coded PDF tickets and a confirmation email (and sometimes a text) go out. This is the Lambda that actually does the work `square-queue-forwarder` just hands off.

## How it fits together

```
Square  →  square-queue-forwarder (API Gateway → SQS)  →  getSquareOrders (this repo)
                                                                 │
                                                                 ├─ verifies the webhook signature
                                                                 ├─ fetches the full order from Square's API
                                                                 ├─ generates a QR-coded PDF ticket per ticketed line item
                                                                 ├─ upserts the Customer row, generates a per-order SMS opt-in token
                                                                 ├─ emails the confirmation + PDF ticket(s)
                                                                 └─ if SMS is enabled and the customer already has consent, texts the ticket too
```

Triggered as an SQS batch processor (consumes what `square-queue-forwarder` enqueues), stateless, looks up per-client config from AWS Secrets Manager and that client's own database on every invocation — nothing about a specific venue is baked into this code.

## What actually determines whether an order gets ticketed

A Square order only produces tickets if its line items have the `UseQRCode` custom attribute (configurable name, see `Client.configuration`) set to true. For each such item, a showtime is read off a modifier (filtered by `MODIFIER_NAME_FILTER`, default `"Show Time"`) whose name follows an exact format: `<Day> <MM-DD-YYYY> <H:MM AM/PM> (<Venue>)`, e.g. `Sun 05-25-2025 8:00 PM (Little Theatre)`. That modifier format is what IndieTix's own Add Movie / Add Event pages generate automatically — if you're ever hand-building a Square item instead of going through those pages, get this exact format wrong and the item silently won't ticket correctly.

## Key files

- `src/index.mjs` — the real entry point, SQS batch handler. Everything that actually runs in production lives here.
- `src/databaseSetup.sql` — a reference copy of the schema this function reads/writes. The real source of truth is the `clientSetup-Teardown` repo's `createDatabaseObjects` function, not this file.

## Shared dependencies (Lambda layers)

- **`sms-utils`** — E.164 phone normalization and centralized SMS sending with consent gating. Shared with `QRScanner` and `smsOptInOptOut` so the three repos don't each carry their own slightly-different copy.
- **`ticket-pdf-lib`** — QR code generation and PDF overlay rendering (drawing the QR code + event details onto a venue's ticket template). Shared with `QRScanner` (used there for the ticket-transfer feature).
- **`square-api-lib`** — every Square API call (the order, payment and customer lookups, custom-attribute lookups, batch-retrieve of the ordered items). Shared with `QRScanner`, `expireQRCodeSquareModifiers`, `marketingEngine` and `squareTokenRefresher`.

All three used to be code living directly in this repo; they're separate npm packages now, built into Lambda layers. See the `infrastructure` repo's `UPDATING.md` for how to change one and redeploy every consumer.

## Environment variables

Per-client values (Square credentials, feature flags, bucket names, ticket filenames, SMS settings — the full list lives in `Client.configuration`, not here) are read from that client's own database at runtime, not from this Lambda's environment. The Lambda's own environment only needs:

| Variable | Purpose |
|---|---|
| `AWS_REGION` | Region for Secrets Manager, S3, and SES clients |
| `TICKET_SIGNER_ACCESS_KEY` / `TICKET_SIGNER_SECRET_KEY` | A dedicated IAM user's long-lived credentials, used only to presign ticket-PDF download URLs. Deliberately *not* this Lambda's own execution-role credentials — an STS-signed URL carries a security token that can push the link past SMS's 1600-character limit; a plain IAM user's keys produce a much shorter URL. Scoped to `s3:GetObject` on `tickets-out/*` only, shared across every client (one of two documented exceptions to this platform's otherwise-total per-client isolation) |

| `SQUARE_API_BASE` | Optional. Square's API address; unset means production. Set to `https://connect.squareupsandbox.com` in an environment that uses Square's sandbox |

Database credentials for each client come from Secrets Manager at `indieTix/rds/clients/{clientId}/credentials` — there's no `DB_HOST`/`DB_PORT` env var on this function at all; the client ID read off the incoming webhook selects which secret to fetch: the `?client=<id>` on the venue's own webhook subscription URL if it has one (Square signs the full URL, so it can't be swapped), otherwise Square's `merchant_id` field.

## Non-obvious behavior worth knowing

- **This handler always marks every SQS message as successfully processed, and never retries.** That's deliberate, not an oversight: Square's own webhook retry behavior is governed entirely by `square-queue-forwarder` (which always returns 200, regardless of anything that happens here), so this function's return value was never visible to Square at all — the only thing a "needs retry" classification would control is SQS's own internal redelivery. Given how costly a wrong failure classification can be on a FIFO queue (one deterministically-failing message blocks every other message behind it in the same group until retries exhaust), the simpler design — always succeed, log clearly, no automatic retry — is the one this repo keeps. If you're extending this handler, don't reintroduce `ReportBatchItemFailures`-based retry logic without understanding this tradeoff first.
- **Bar/concession orders share this same webhook.** Not every Square order is for a ticketed item — a walk-up candy or drink sale fires the same webhook. `processWebhook` has to handle that case explicitly (an order with no ticketed line items is a normal, successful no-op, not an error) rather than falling through unhandled. Square sends about three webhooks per sale, so an order already found to have no tickets is remembered in the venue's `NoTicketOrder` table (Square order IDs only, kept 90 days) and skipped the next time, instead of being fetched and checked again.
- **Tickets record which showing they're for.** Each ticket line's showtime modifier is looked up in IndieTix's own event records (`src/native-events.mjs`); when found, `QRCodeProduct.ShowingID` is set and the showing's date and room are used. A line whose item IndieTix knows but whose showtime it doesn't (someone added a showtime in Square by hand) is still ticketed from the showtime text and logged as `UNMATCHED_SHOWTIME` (alarm `<prefix>-showtime-out-of-sync`).
- **Full showings stop selling, if the venue turns it on** (`ENFORCE_CAPACITY`, Client Settings, off by default). After the tickets and email, each showing the order sold is counted; once sold tickets reach capacity minus held seats, the showtime modifier is deleted from Square, the showing is marked sold out (`SHOWING_SOLD_OUT` in the log), and the item is archived if no upcoming showing is still on sale. A failure here never fails the order; it logs `CAPACITY_ENFORCEMENT_FAILED`.
- **SMS body times are Chicago wall-clock, formatted without round-tripping through a JS `Date` object.** `ProductDate` is stored as `TIMESTAMP WITHOUT TIME ZONE` representing Chicago local time with no timezone suffix — parsing that string with `new Date(...)` in a Lambda (which runs in UTC) and then re-formatting with a timezone conversion double-applies the offset. The SMS formatter parses the wall-clock digits directly instead.
- **`oauth.authorization.revoked` is handled here too.** When a Connect Square (OAuth) venue removes IndieTix in Square, this sets `SQUARE_OAUTH_REVOKED_AT` on the venue and emails it once, asking someone to click "Reconnect Square". Personal-token venues are left alone.
- **Configuration is logged as key names only.** Values include Square tokens and FTP passwords.
- **Every invocation logs the raw event first.** Deliberate, for CloudWatch debugging — if you're tracing a specific order, start there.

## Testing

`npm test` runs `node --test test/*.test.mjs` against a throwaway Postgres container (Docker). `test/recordedOrders.test.mjs` replays 15 real, anonymized Liberty Hall sales (`test/fixtures/liberty-hall/`, see its README) and requires the exact rows, email and repeat-webhook behavior production produced; `nativeShowings.test.mjs` and `noTicketOrder.test.mjs` cover the showing lookup, sold out and the concession guard. Square calls are mocked; an unmocked one fails the test.

## Deploying

See the `infrastructure` repo's `deploy.sh` (`./deploy.sh deploy getSquareOrders`) and `UPDATING.md` for the full workflow, including testing a change in a sandbox account before it touches production.
