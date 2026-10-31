# Updating the Infrastructure

**Last Edited:** 2026-10-28

Worked examples for the changes you'll actually make after the platform is running — fixing a bug, adding a config field, changing a shared library, standing up a second environment to test something bigger. Each one assumes `deploy.config.sh` (production) and/or `bootstrap.config.sh` (a sandbox/second environment) already exist — see README.md if not.

## Example 1: fix a bug in one Lambda, prove it in sandbox, ship it

Say you found a bug in `getSquareOrders`. The code lives in the real `getSquareOrders` repo (a sibling of `infrastructure/`, not inside this repo — see this repo's own README for why, and the "one true source" note in `.gitignore` if you're curious about the history there).

```bash
cd getSquareOrders
# make your fix in src/
cd ../infrastructure
./deploy.sh lint getSquareOrders      # syntax + import check, no AWS calls
./deploy.sh diff getSquareOrders      # see exactly what would change, vs. what's live
./deploy.sh deploy-dev getSquareOrders  # ship to your sandbox account, no prompt
```

Test it for real against the sandbox environment. Once you're satisfied:

```bash
./deploy.sh deploy getSquareOrders    # shows the diff again, prompts for confirmation
```

That's it — `deploy`/`deploy-dev` both build fresh from the real repo every time, so there's never a separate "staged" copy to keep in sync.

**Timing note, not just mechanics:** `getSquareOrders` and `QRScanner` process real customer traffic. Per this project's own operating convention, avoid deploying changes to either one around a venue's highest-traffic windows (e.g. weekend evenings) — a sandbox-proven change is still safer shipped on a quiet day than a busy one.

## Example 2: add a new environment variable to a Lambda

Say a Lambda needs a new piece of config that isn't part of a client's `Client.configuration` — something environment-wide, like `TICKET_TEMPLATES_BUCKET` was for `client-setup-teardown` (a real example already in this repo).

1. Add a `Parameters:` entry and wire it into `Environment: Variables:` in that stack's `template.yaml`:
   ```yaml
   Parameters:
     MyNewSetting:
       Type: String
       Description: What this controls and why it's a parameter, not hardcoded
   Resources:
     MyFunction:
       Properties:
         Environment:
           Variables:
             MY_NEW_SETTING: !Ref MyNewSetting
   ```
2. If the Lambda needs new IAM permissions to use it (e.g. reading from a new bucket), add a `Policies:` statement scoped as narrowly as possible — see any existing stack's `template.yaml` for the pattern (every policy in this repo names an exact `Resource` ARN, never a bare `"*"` unless the AWS API genuinely has no resource-level permissions, like `secretsmanager:ListSecrets`).
3. Pass the value when deploying — for `bootstrap.sh`, add it to `bootstrap.config.sh` and thread it through `cmd_up`'s `deploy_stack` call for that stack (see `seed_ticket_templates_bucket`/`TicketTemplatesBucket` in `bootstrap.sh` for a complete real example of exactly this). For a one-off production change via `deploy.sh`, you'd do the equivalent `sam deploy --parameter-overrides` by hand, or extend `deploy.sh`'s own config loading if it's a value you'll set repeatedly.

## Example 3: add a new per-client config field

Every client has a `Client.configuration` JSON blob — this is how almost all per-venue settings work, rather than adding database columns. `FILM_CODE_PREFIX` (used in box office report film codes) is a real, already-shipped example of this exact pattern:

1. **Add the default** in `clientSetup-Teardown/src/index.js`'s `insertClientRecord` function — this is the canonical source of truth for a fresh client's starting config.
2. **Add the key name** to the `USER_DEFINABLE` array in the same file, if a venue should be able to change it themselves via Client Settings (most should be).
3. **Add a migration** in `clientSetup-Teardown/src/migrations.sql` — idempotent (`UPDATE ... WHERE configuration->>'YourNewField' IS NULL`, or similar), so every *existing* client gets a sensible default too, not just new ones going forward. Migrations here are meant to be safe to re-run.
4. **Add the Client Settings UI field** in `QRScanner/src/public/client.html`/`client.js` if it's something an operator should actually see and edit, not just an internal/computed value.
5. **Read it** wherever it's needed — `clientConfig.YOUR_NEW_FIELD` — remembering the project-wide convention that config values are sometimes JSON booleans and sometimes JSON strings depending on how they were written, so a boolean-like field should check both `=== true` and `=== 'true'` (see `SEND_SMS` for the established pattern).
6. Deploy whichever Lambdas actually read the new field, using Example 1's flow.

## Example 4: update a shared Lambda layer

`sms-utils` and `ticket-pdf-lib` are real npm packages (their own repos), built into Lambda layers and attached to every Lambda that uses them — not copy-pasted per-repo. Changing one means rebuilding the layer, then re-attaching it to each consumer so they actually pick up the new version (an attached layer version doesn't auto-update).

```bash
cd sms-utils
# make your change in src/
cd ../infrastructure
./deploy.sh deploy-layer sms-utils-qrscanner      # builds + publishes a new layer version
./deploy.sh attach-layer sms-utils-qrscanner      # attaches it to QRScanner's function
./deploy.sh attach-layer sms-utils-get-square-orders
./deploy.sh attach-layer sms-utils-sms-opt-in-opt-out
```

Why three separate `attach-layer` calls for one `deploy-layer`: `sms-utils` is one package but three different Lambdas consume it (see `infrastructure/lib/repo-config.sh` — `sms-utils-qrscanner`, `sms-utils-get-square-orders`, `sms-utils-sms-opt-in-opt-out` all share the same `LAYER_NAME`, built from the same source). One publish, multiple attaches — `./deploy.sh status` will flag any function still running an older layer version than what's published, if you want to double check nothing got missed.

## Example 5: stand up a second environment to test something bigger

For a change too large or risky to just sandbox-test one Lambda at a time — a schema migration, a new shared resource, anything you want to prove end-to-end before it touches production — `bootstrap.sh` can spin up an entire second, fully isolated environment (its own Aurora cluster, its own S3 buckets, its own everything, namespaced by `ENV_PREFIX` so it can't collide with anything else in the same AWS account/region):

```bash
cp bootstrap.config.sh.template bootstrap.config.sh
# set a new ENV_PREFIX (e.g. "myfeature-test"), fill in the rest
./bootstrap.sh up
```

Test your change against this environment exactly like you would production, using the Function URLs and CloudFront domain it prints at the end. When you're done:

```bash
./bootstrap.sh down
```

This permanently deletes every stack for that `ENV_PREFIX` — double-check `ENV_PREFIX` in `bootstrap.config.sh` is actually the throwaway environment before running it, not production.

## Example 6: change the public API

The `/v1` API lives in `QRScanner/src/app.mjs` (the `PUBLIC API v1` block), and its reference docs are `QRScanner/src/public/openapi.yaml`. They have to stay in step.

1. **Only change `/v1` additively.** New endpoints, new optional query parameters and new response fields are fine. Renaming or removing anything, or changing what a field means, breaks someone's integration, so that belongs in a new `/v2`.
2. **Update `openapi.yaml` in the same PR.** `test/apiV1.test.mjs` compares the spec's routes against the code's routes and fails CI if they drift.
3. **New data access gets a scope.** If an endpoint exposes something no existing scope covers, add a scope (to `V1_SCOPES` in `app.mjs`, the scopes table in `openapi.yaml`, and the API Keys checkboxes in `client.html`/`client.js`) rather than widening an existing one. Buyer contact info only ever goes out under `orders:pii`.
4. **Respect the key's data filter.** Any endpoint that returns or touches tickets has to apply the key's `DataFilter`, and anything outside it should answer exactly like "not found".
5. **A schema change** (a new table or column the API needs) follows Example 3's pattern: add it to `createDatabaseObjects` for new venues and to `migrations.sql` for existing ones, then run the migration before deploying the code.
6. Deploy QRScanner with Example 1's flow, and push the static site too so `/api-docs.html` serves the updated spec.
