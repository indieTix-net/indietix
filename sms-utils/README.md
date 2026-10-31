# sms-utils

**Last Edited:** 2026-10-28

Shared phone normalization and centralized SMS sending for IndieTix, packaged as a Lambda layer.

## Why this exists

`phone.mjs` and `sms.mjs` used to be physically duplicated, byte-for-byte identical, across three repos: `getSquareOrders`, `smsOptInOptOut` (phone.mjs only -- that Lambda never sends outbound), and `QRScanner`. The project's own convention was "duplicate until a 4th consumer needs it" -- but all three copies drifting apart silently was always the risk, and building real test infrastructure for the platform was the natural trigger to finally extract this for real instead of writing (and maintaining) the same tests three times.

All three consuming repos now depend on this package instead of carrying their own copy.

## What's in it

- `normalizeToE164(input)` / `formatForDisplay(e164)` / `maskForDisplay(e164)` -- US/Canada phone normalization and display formatting. Pure functions, no dependencies.
- `sendSms({ toPhone, body, clientConfig, pool, bypassConsentCheck })` -- the one place in the codebase that should call AWS End User Messaging's `SendTextMessageCommand`. Verifies `SEND_SMS`/origination config, normalizes the destination, checks active `SmsConsent` (unless explicitly bypassed for inbound STOP/HELP auto-replies), runs a per-client spend circuit breaker, sends, and logs to `SmsOutboundLog`.
- `buildMessageBody(senderBrand, content)` -- standard brand prefix + required STOP/HELP footer.

`pool` (a `pg` Pool/Client) and `clientConfig` (the client's `Client.configuration` JSON) are passed in by the caller rather than constructed internally -- the only AWS client this module builds itself is the Pinpoint SMS Voice v2 client, which is fine to mock at the class level (see Tests).

## Tests

```
npm install
npm test
```

`phone.mjs` is pure and tested directly. `sendSms`'s SQL (a consent lookup, a count query, an insert, an occasional prune) is simple parameterized CRUD, not the kind of correctness-critical SQL this platform's box-office reporting functions are -- so a small hand-rolled fake `pool` in the test file is the right level of infrastructure here, not a real Postgres instance. The AWS Pinpoint call is mocked via `aws-sdk-client-mock`, which intercepts at the client class level regardless of where the instance was constructed -- no dependency injection needed to make this testable.

## Using this as a Lambda layer

Same `deploy-layer`/`attach-layer` pattern as `ticket-pdf-lib` (see `infrastructure/DEPLOY.md` and that repo's README) -- package `src/` + `node_modules/` (minus devDependencies) into the layer, attach to each consuming function, import via the layer's mount path at runtime.
