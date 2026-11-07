# deploy.sh

> The unified build/deploy tool for every indieTix Lambda, their layers, and QRScanner's static site. Lives here in `infrastructure/`, but operates on the sibling service folders one level up (`ROOT`, the repo root) -- its core job is production code deploys, not infra/SAM concerns; it just also knows how to ship code to this repo's sandbox stacks (`deploy-dev`).

## Setup (one-time)

`deploy.sh` refuses to run without a `deploy.config.sh` present in this same directory -- it holds this deployment's specific, non-generic values (real AWS account ID, CloudFront distribution ID, S3 bucket names, sandbox profile/region) and is gitignored, never committed. Copy `deploy.config.sh.template`, fill in your own values, and you're set:

```
cp deploy.config.sh.template deploy.config.sh
# edit deploy.config.sh with your own values
```

## Why this exists

The user deploys exclusively via the AWS Console/CLI by hand, never `serverless deploy` (even though some repos have a `serverless.yml` lying around as a leftover reference) — **never trust local repo state as automatically matching what's live.** This script was built specifically to make that safe: every command that touches AWS shows a real diff against the live code first, and nothing deploys without that diff being shown (and, by default, a confirmation prompt).

## Core safety properties (don't remove these)

- **Diff-before-deploy, always.** `cmd_deploy` and `cmd_deploy_all` fetch the actual live `code.zip` from Lambda and diff it against the locally-built zip before ever asking to proceed. This is what it looked like in practice to catch real drift, like a missing utility file that would have caused a production outage.
- **Lint-before-build, always.** `build_zip` calls `lint_build` before producing any zip — syntax-checks every staged `.js`/`.mjs` file, then walks every local `import`/`require` and verifies the target actually exists in that same build. This is the automated version of the exact bug caught by hand once (QRScanner missing `crypto-utils.mjs`/`data-filter-utils.mjs`) — it cannot be skipped, because every build path runs through it.
- **`confirm()` gates every production-mutating action**, and respects `--yes`/`-y` to skip the prompt for scripted use. Never bypass this by hardcoding `--yes` into a habit without actually looking at the diff first. `deploy-dev` deliberately does NOT have this gate -- see its row below.
- **File lists per repo are hand-verified, not guessed** (see the comment at the top of the script) — if a new source file is added to a repo, it must be added to that repo's `FILES` list in `load_config()` here too, or deploys will keep working but silently omit the new file. This same list is reused by `deploy-dev`, so there is exactly one source of truth for "what files does this Lambda need," not two that can drift apart.

## Commands

| Command | What it does |
|---|---|
| `status` | Lists every Lambda function + every layer's latest version, and flags any function whose attached layer version is stale vs. the latest published one (caught a real case of this: QRScanner running layer v13 when v14 had already been published but never attached). |
| `list-repos` | Lists every repo name the script knows about. |
| `lint [repo]` | Syntax + unresolved-import check. Omit `repo` to lint everything, including the static site's local script/css references. Runs automatically inside every build anyway — useful standalone to check everything without deploying. |
| `diff <repo>` | Builds locally, fetches live, shows what would change. No AWS mutation. |
| `build <repo>` | Builds the zip only, lists its contents. No AWS calls at all. |
| `deploy <repo> [--yes]` | Build, diff vs. live, confirm, `update-function-code`, poll until `LastUpdateStatus` is `Successful`, then print a config sanity check (layers/handler/runtime/memory/timeout). |
| `deploy-all [--yes]` | Diffs every repo, shows which ones actually changed, confirms once, deploys only those. |
| `deploy-dev <repo>` | Same build as `deploy` (same `FILES` list, same lint-before-build) but shipped to that repo's sandbox Lambda in the separate dev/test AWS account + region (`DEV_PROFILE`/`DEV_REGION` in `deploy.config.sh`) instead of production — see this repo's SAM templates (siblings of this file) for what provisioned those sandbox stacks. No confirmation prompt; the point is fast iteration, and production stays the only place that pauses to ask. Shows the diff vs. what's currently in the sandbox purely for visibility. |
| `deploy-layer <repo>` | Rebuilds that repo's Lambda layer from its `package.json` (`npm install --omit=dev --os=linux --cpu=x64 --libc=glibc` — the exact flags needed to get Linux binaries on a Mac; the deprecated `--platform`/`--arch` flags are silently ignored by npm 11 and will grab the wrong binary), prunes sharp's unused musl/wasm32 variants (see below), zips, and publishes a new layer version. **Does not attach it** — that's a separate explicit step. |
| `attach-layer <repo>` | Attaches the latest published layer version to that repo's function, explicitly preserving any other already-attached layers (e.g. `LambdaInsightsExtension`) that don't match this layer's name. |
| `static-diff` | Compares every file in `QRScanner/src/public/` against what's actually live in the static-site S3 bucket (`STATIC_BUCKET` in `deploy.config.sh`). |
| `lint-static` | Just the static-site half of `lint` — verifies every local `<script src>`/`<link href>` in `QRScanner/src/public/*.html` resolves to a file that exists. |
| `static-push <filename>` | Pushes one specific static file to S3 (correct `Content-Type` inferred from extension) and invalidates its CloudFront path. |
| `invalidate [path...] [--wait]` | CloudFront-only cache clear (no S3 upload). Defaults to `/*`. `--wait` blocks until the invalidation actually completes instead of just kicking it off. |

## Known gotchas already hit once (fixed in the script, but worth knowing why)

- **npm 11 silently ignores `--platform`/`--arch`** for native-binary packages like `sharp` — must use `--os=linux --cpu=x64 --libc=glibc` instead, or the layer ships darwin binaries that crash on Lambda.
- **Lambda's `PublishLayerVersion` has a ~70MB *base64-encoded* direct-upload size limit.** A 53MB zip can still fail because the AWS CLI base64-encodes it for the API call, inflating it ~33%. If a layer rebuild ever fails with `RequestEntityTooLargeException` again (e.g. a new large dependency gets added), the fix is either pruning dead weight (like the sharp musl/wasm32 variants already pruned here) or switching to an S3-based `publish-layer-version --content` call instead of `--zip-file`.
- **`--max-items 1` + `--output text` + a JMESPath query can leak a bogus extra line** from AWS CLI's pagination — use `--no-paginate` instead when you just want one value.
- **bash 3.2 (macOS's shipped bash) has no associative arrays** — that's why `load_config` is a `case` statement, not a lookup table.
- **`"${arr[@]}"` on a genuinely empty array throws `unbound variable` under `set -u` on bash 3.2** (fixed in bash 4.4+, but this script targets 3.2). `fetch_live_zip`/`poll_update_status`'s optional `--profile`/`--region` args build an array that's empty for every production call site — expanding it with the portable `${arr[@]+"${arr[@]}"}` idiom instead of plain `"${arr[@]}"` is what keeps those call sites working.
- **zsh doesn't word-split unquoted variable expansion in `for x in $var` by default**, unlike bash — this script is bash (`#!/bin/bash` + explicit invocation), so it's fine, but don't assume the same pattern is safe if porting logic into an interactive zsh one-liner.
- **`exit` vs `return` inside reusable functions**: `build_zip`'s two failure paths use `return 1`, not `exit 1`. If this ran in a `for repo in $ALL_REPOS` loop (like `cmd_lint` does) and used `exit`, one bad repo would kill the entire multi-repo run instead of just being reported and skipped.

## Things this script deliberately does NOT do

- No IaC / no `serverless.yml` deploys for production — production is intentionally just AWS CLI calls wrapped with safety checks, matching how the user already works (console + hand-verified diffs), not a new deployment paradigm. (`deploy-dev` is the one place this script does touch something provisioned by IaC -- the sandbox Lambdas this same repo's SAM templates created -- but it still only ever does a plain `update-function-code`, never a CloudFormation deploy.)
- No automatic EventBridge/schedule management — those are set up directly via `aws events put-rule`/`put-targets` when needed (e.g. `marketingEngine-poller`), not tracked by this script.
- No secrets handling — `Client.configuration` and Secrets Manager are read directly via `aws` CLI/psql when needed, never touched by this script.

## Production error alarms (`alarms/template.yaml`)

Separate from this script: one CloudFormation stack, `indietix-prod-alarms` (us-east-2), holding only CloudWatch alarms, one log metric filter and the SNS topic that emails them. It's the one piece of production made by IaC, because alarms touch nothing a function runs on. It emails when an alarm fires and again when it clears:

- ticket orders: getSquareOrders logs an `ERROR` line, crashes, or an order waits in `webhook_square_processing.fifo` over 5 minutes
- the Square webhook: square-queue-forwarder crashes, or the `getSquareOrders/prod` API returns 5xx
- QRScanner: 2+ server errors (Function URL 5xx) in 5 minutes, or a crash
- any crash of the inbound SMS handler, expireQRCodeSquareModifiers, DailyPgQueryAndSftp, marketingEngine or the indietix.net mail forwarder

Update it (after editing the template):

```
aws cloudformation deploy --region us-east-2 --stack-name indietix-prod-alarms \
  --template-file alarms/template.yaml --parameter-overrides AlertEmail=<address>
```

A new `AlertEmail` must click the AWS confirmation email before anything arrives. Test delivery with `aws cloudwatch set-alarm-state --region us-east-2 --alarm-name indietix-prod-qrscanner-crashed --state-value ALARM --state-reason test` (it flips back to OK by itself at the next evaluation). Function names are template parameters, since production's functions were made by hand; `bootstrap.sh` deploys the same template for its environments (`deploy_alarms`). QRScanner's public status page (`status.html`, `GET /api/public/status`) reads these alarms when QRScanner has `STATUS_ALARM_PREFIX=indietix-prod` and its role allows `cloudwatch:DescribeAlarms`.

## Account security (`security/template.yaml`)

Stack `indietix-prod-security` (us-east-2, live 2026-11-06): GuardDuty threat detection, a multi-region CloudTrail trail of every AWS account action (management events only, kept 365 days in `indietix-prod-cloudtrail-<account>`, log file validation on), and SNS topic `indietix-prod-security`, which emails each GuardDuty finding of severity 4 or higher (medium and high). It watches the account and blocks nothing. GuardDuty reads IAM and other global events from this region; other regions aren't watched.

```
aws cloudformation deploy --region us-east-2 --stack-name indietix-prod-security \
  --template-file security/template.yaml --parameter-overrides AlertEmail=<address>
```

Test the email with `aws guardduty create-sample-findings --region us-east-2 --detector-id <id> --finding-types 'Backdoor:EC2/C&CActivity.B!DNS'`. `bootstrap.sh` deploys the same template (`deploy_security`), skipping GuardDuty or the trail when the account already has one, and `down` stops the trail and empties its bucket first.

## API firewall (`api-edge/template.yaml`)

Stack `indietix-prod-api-edge` (us-east-1, live 2026-11-06): CloudFront `https://d2dp74tg29n4ng.cloudfront.net` plus WAF web ACL `indietix-prod-api` in front of QRScanner's Function URL, and the header secret `indieTix/edge/indietix-prod` (us-east-1). Production's `config.js` points `INDIETIX_API_URL` at it. QRScanner refuses direct calls to its Function URL only once its env has `EDGE_ORIGIN_SECRET` (the secret's `secret` value, merged into the existing env, keeping `TICKET_SIGNER_*`). Set that on a quiet weekday, after staff devices have reloaded the new `config.js`; until then the firewall can be bypassed by calling the old address. Remove `EDGE_ORIGIN_SECRET` to switch the check back off, and restore `config.js` from `.prod-backups/2026-11-06-api-edge/` to stop using the edge.

```
aws cloudformation deploy --region us-east-1 --stack-name indietix-prod-api-edge \
  --template-file api-edge/template.yaml \
  --parameter-overrides EnvPrefix=indietix-prod ApiOriginDomain=<Function URL host>
```

## Support inbox (`support/`, `support/template.yaml`)

Email to support@indietix.net gets filed under a ticket and a drafted reply; a person reviews, edits and sends every reply from the local inbox (`./support.sh`). Nothing is sent automatically, and the existing forwarding of support@ to Gmail is unchanged.

- **Stack** `indietix-prod-support` (us-east-2): Lambda `indietix-prod-support-intake` (code in `support/`), its log group (30 days), and SES receipt rule `indietix-prod-support-inbox` in the active rule set `tickets` (S3 copy to `indietix-net-inbound-mail/support/`, then the Lambda). The forward rule `indietix-net-forward` is not part of the stack.
- **Data:** tables `SupportTicket` and `SupportMessage` in the `indietix` platform database (`support/schema.sql`, created by the `indietix` login), reached through the RDS Data API with the `support_inbox` login (secret `indieTix/support/db`; created by the `libertyhall` master, which can create roles). Tickets idle for 2 years are deleted by the Lambda.
- **Drafts:** Claude Opus 5.5 with the public knowledge pack in `support/knowledge/`; the key is `indieTix/support/anthropic` (`{"api_key"}`), separate from any venue's.
- **Deploy:** `sam build -t infrastructure/support/template.yaml && sam deploy` with the parameters in the template (production: `ReceiptRuleSet=tickets`, `InboundBucket=indietix-net-inbound-mail`, the cluster and the two secret ARNs).
- **Inbox settings** in `deploy.config.sh`: `SUPPORT_FUNCTION`, `SUPPORT_DB_CLUSTER_ARN`, `SUPPORT_DB_SECRET_ARN`, optional `SUPPORT_BCC`.

## Venues' own web addresses (`<name>.indietix.net`)

Each venue can pick a web address under one domain (QRScanner's `VENUE WEB ADDRESS`: Client Settings, or the signup form). Every name reaches the environment's one static site; QRScanner reserves a name by writing `venue-sites/<name>/` (`site.json`, `privacy.html`, `terms.html`) in the static site bucket, and sets the venue's `STATIC_WEBSITE_URL`. The login page reads `site.json` to fill in the Client ID. Teardown frees the name.

Needs, once per environment (production: done for `indietix.net`, 2026-11-06):
- a certificate for `*.<domain>` in us-east-1 (ACM, DNS-validated)
- the `*.<domain>` alias on the static site's CloudFront distribution, with that certificate (`sni-only`; never `vip`, which is dedicated-IP SSL at about $600/month)
- a wildcard DNS record (A and AAAA alias) pointing at the distribution
- `static-site/venue-legal-pages.js` as a CloudFront Function (domain filled in), on viewer-request for two cache behaviors, `/privacy.html` and `/terms.html`, copied from the default behavior. Other hosts, including the distribution's own `*.cloudfront.net` address, pass through.
- QRScanner env `VENUE_SITE_DOMAIN=<domain>` (bootstrap: `VENUE_SITE_DOMAIN` in the config) and `STATIC_SITE_BUCKET`; client-setup-teardown `STATIC_SITE_BUCKET` (to free names)
- `window.INDIETIX_VENUE_SITE_DOMAIN = '<domain>'` in `config.js`

## Broader context

For the platform this script deploys — architecture, multi-tenancy model, per-repo details — see `README.md` here and at the repository root.
