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

## Broader context

For the platform this script deploys — architecture, multi-tenancy model, per-repo details — see README at the workspace root (one level up from this repo).
