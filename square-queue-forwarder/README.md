# square-queue-forwarder

**Last Edited:** 2026-10-28

The first hop for every Square webhook event IndieTix processes — the URL you register directly with Square. Its entire job is to acknowledge the webhook instantly and hand the raw payload to SQS for `getSquareOrders` to actually process. No business logic, no signature verification, no database access.

## Why it exists as its own Lambda

Square expects a webhook response quickly and will retry (and can eventually disable a repeatedly-failing subscription) if it doesn't get one. Order processing — fetching the full order from Square's API, generating PDF tickets, sending email/SMS — takes real time and can fail for reasons that have nothing to do with whether the webhook itself was valid. Splitting "acknowledge the webhook" from "process the order" means a slow or failing downstream step never risks Square's opinion of the endpoint.

## What it actually does

`src/index.mjs` is the whole function:

1. Receives the API Gateway event, parses it if it arrived as a string.
2. Packages the body, headers, path/query params, and request context into one message object (headers are kept specifically so `getSquareOrders` can still verify Square's signature downstream — this function doesn't check it).
3. Sends that message to the SQS queue at `WEBHOOK_QUEUE_URL`.
4. If the queue is FIFO (`.fifo` suffix), sets `MessageGroupId` to the order's `merchant_id` (Square's own field, read straight off the webhook body) — so one client's processing problem can never block another client's messages from being delivered, since FIFO SQS strictly serializes delivery *within* a group but not across groups. Falls back to a shared group only if `merchant_id` can't be parsed out of the body.
5. Returns `200` to Square — **always**, even if the SQS send itself fails. The error gets logged, not surfaced to Square; the alternative (returning a non-200 on an internal failure) just causes Square to retry a webhook that was never the problem in the first place. If you're watching for silent failures, watch CloudWatch logs, not Square's webhook retry count.

## Environment variables

| Variable | Purpose |
|---|---|
| `WEBHOOK_QUEUE_URL` | The SQS queue URL to forward to (FIFO or standard — behavior above adapts automatically based on the URL's suffix) |
| `AWS_REGION` | Region for the SQS client |
| `NODE_ENV` | Set to `development` to skip the headers/path/query packaging and just forward the raw event body — useful for local testing without a real API Gateway event shape |

No Square credentials, no database access, no Secrets Manager calls — this function genuinely doesn't need any of that to do its job.

## Local testing

Set `NODE_ENV=development` and invoke the handler directly with a plain object as the event (not a full API Gateway event shape) — see the `NODE_ENV !== "development"` branch in `src/index.mjs` for exactly what gets skipped.

## What this replaced

An earlier design used a separate Lambda authorizer in front of the webhook, doing signature verification before forwarding anything (archived in `oldOrNotUsedIThink/squareWebhookAuthorizer/` in the workspace, if you have access to the full monorepo). Signature verification now happens downstream in `getSquareOrders` instead — this function doesn't validate the payload at all, it just moves it along.

## Deploying

See the `infrastructure` repo's `deploy.sh` — this repo is one of the Lambdas it knows how to build and ship (`./deploy.sh deploy square-queue-forwarder`). No Lambda layer needed; its only real dependency is the AWS SDK, already present in the Lambda runtime.
