# Command cheat sheet

One page of the commands you actually run, grouped by what you're trying to do. Run everything from `infrastructure/`. For the why and the details, see [README.md](./README.md) (setup walkthrough), [DEPLOY.md](./DEPLOY.md) (the deploy tool), and [CLIENT_SETUP.md](./CLIENT_SETUP.md) (adding venues). Both scripts also print their own help: `./bootstrap.sh --help`, `./deploy.sh --help`.

**Which AWS account does a command touch?**

- `bootstrap.sh` acts on the environment named in `bootstrap.config.sh` (`ENV_PREFIX`, `AWS_REGION`, `AWS_PROFILE`). Check that file before every run.
- `deploy.sh` acts on **production** (`deploy.config.sh`: `REGION`, `ACCOUNT_ID`), except `deploy-dev`, which goes to the sandbox (`DEV_PROFILE`, `DEV_REGION`).

Legend: **read-only** = changes nothing · **sandbox** = sandbox only · **PROD** = changes production · **ENV** = changes whichever environment `bootstrap.config.sh` names.

## Stand up or tear down a whole environment (`bootstrap.sh`)

| Command | What it does | Touches |
|---|---|---|
| `./bootstrap.sh up` | Deploys all 12 stacks in order, creates or updates the Square webhook (if `SQUARE_WEBHOOK_AUTO="true"`), and onboards the first venue with `FIRST_CLIENT_SETTINGS_FILE`. Asks first. Safe to re-run; onboarding fails cleanly once the venue exists. | ENV |
| `./bootstrap.sh up --yes` | Same, no prompt (for unattended runs). | ENV |
| `BOOTSTRAP_CONFIG=bootstrap.config.<name>.sh ./bootstrap.sh up` | Same, for a second environment with its own (gitignored) config file. Works with every command. | ENV |
| `./bootstrap.sh down` | Removes the Square webhook (only if it points at this environment), offboards every venue, deletes every stack, bucket, layer and the Aurora cluster. **Not reversible. Never against production** (with `ENV_IS_PRODUCTION="true"` it refuses unless you add `--production`, then makes you type the name). | ENV |
| `./bootstrap.sh block` | Emergency stop: every Lambda in the environment rejects all requests. What the cost-guard breaker does when the daily budget trips. | ENV |
| `./bootstrap.sh unblock` | Undo `block` or a tripped breaker. | ENV |
| `./bootstrap.sh breaker-status` | Shows each Lambda as open or BLOCKED. | read-only |

## Ship a code change (`deploy.sh`)

The normal path is: test → sandbox → diff → production, on a quiet weekday (never Sunday for `getSquareOrders` or `QRScanner`).

| Command | What it does | Touches |
|---|---|---|
| `./deploy.sh list-repos` | The folder names `<repo>` accepts. | read-only |
| `./deploy.sh lint [repo]` | Syntax and import check; everything if no repo given. Runs inside every build anyway. | read-only |
| `./deploy.sh build <repo>` | Builds the zip and lists what's in it. No AWS calls. | read-only |
| `./deploy.sh deploy-dev <repo>` | Ships the build to that Lambda in the sandbox. No prompt. | sandbox |
| `./deploy.sh diff <repo>` | What would change in production if you deployed now. | read-only |
| `./deploy.sh deploy <repo>` | Shows the diff, asks, deploys, waits until it's live, prints a config check. | **PROD** |
| `./deploy.sh deploy-all` | Diffs every repo, then deploys only the ones that changed (one prompt). | **PROD** |
| `./deploy.sh status` | Every function and layer, flagging any function not on its layer's latest version. | read-only |

Before a genuinely new production change, save a revert anchor, a copy of the live code you'd roll back to: `curl -o <fn>-before.zip "$(aws lambda get-function --function-name <fn> --query Code.Location --output text)"`. To roll back, `aws lambda update-function-code --function-name <fn> --zip-file fileb://<fn>-before.zip`.

## Layers (shared dependencies)

| Command | What it does | Touches |
|---|---|---|
| `./deploy.sh deploy-layer <repo>` | Rebuilds the layer for Linux and publishes a new version. Does **not** attach it. | **PROD** (new version, unused until attached) |
| `./deploy.sh attach-layer <repo>` | Points the function at the latest layer version, keeping other layers attached. | **PROD** |

Usually run together: `./deploy.sh deploy-layer QRScanner && ./deploy.sh attach-layer QRScanner`.

## Static site (QRScanner's pages)

| Command | What it does | Touches |
|---|---|---|
| `./deploy.sh lint-static` | Checks every local script/css link in the pages exists. | read-only |
| `./deploy.sh static-diff` | Which files in `QRScanner/src/public/` differ from what's live. | read-only |
| `./deploy.sh static-push <file>` | Uploads one file (e.g. `client.js`, `logo.png`) and clears its cache. | **PROD** |
| `./deploy.sh static-push-legal` | Publishes `privacy.html` and `terms.html` for `LEGAL_CLIENT_ID` (deploy.config.sh), filled from that venue's Terms & Privacy fields in Client Settings. Shows a diff vs. live and asks. Refuses if the venue's fields are still blank. (`static-push` refuses these two files: the repo copies are "Your Venue" placeholders.) | **PROD** |
| `./deploy.sh invalidate [path...] [--wait]` | Clears CloudFront's cache for those paths, or everything. | **PROD** (cache only) |

`QRScanner/src/public/config.js` is per-deployment and gitignored: it holds that environment's API URL. Push it with `static-push config.js` after an `up` creates a new API URL.

## Venues

| Task | How | Touches |
|---|---|---|
| List venues | `./bootstrap.sh list-clients` | read-only |
| Add a venue | `cp venue.json.template venues/<name>.json`, fill it in, then `./bootstrap.sh add-client venues/<name>.json`. Sets up that venue's Square webhook (with `square_webhook.auto`) and onboards it. Safe to re-run. Field details in [CLIENT_SETUP.md](./CLIENT_SETUP.md). | ENV |
| Remove a venue | `./bootstrap.sh remove-client venues/<name>.json` (also removes its Square webhook), or `remove-client <clientId>` (offboard only). Deletes that venue's database, secret and buckets. Only acts on a venue in this environment. **Not reversible.** | ENV |
| One-off SQL | `aws lambda invoke --function-name <env-prefix>-sql-runner --payload '{"database": "<clientId>", "sql": "...", "params": [...]}' ...` | ENV |
| Change a venue's settings | Log in to the site → Client Settings (client login). | that venue |

## Tests

| Command | What it does |
|---|---|
| `cd ../<folder> && npm install && npm test` | Runs that folder's suite locally. Needs Docker running and Node 22. |
| Actions tab → **Run workflow** | Runs every suite in CI. Pull requests run only the suites their changes affect. |
