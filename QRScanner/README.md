# QRScanner

**Last Edited:** 2026-10-28

The operator-facing side of IndieTix: an Express app that serves the staff dashboard, ticket scanner, event creation, cinema creation, reporting pages, client settings, and the Marquee Engine marketing UI, plus the public API endpoints the customer-facing pages (SMS opt-in, email unsubscribe) hit. Deployed as a single Lambda behind a Function URL via `serverless-http`.

Part of the IndieTix platform: a multi-tenant, share-nothing ticketing system for independent cinemas and venues. Each client (venue) has its own Postgres database, S3 buckets, and Square credentials; this app looks up per-client configuration from AWS Secrets Manager and each client's own database on every request — there's no local/dev database with a mix of all clients' data, every request resolves one client's isolated world from scratch. For what the platform actually lets a venue do, see [`infrastructure/FUNCTIONALITY.md`](../infrastructure/FUNCTIONALITY.md) — this README is about the codebase, not the feature tour.

## Pages (`src/public/`)

One HTML/JS/CSS trio per page, all loaded with `config.js` as the first script tag:

| Page | Purpose |
|---|---|
| `login.html` | The one login form — see **Auth model** below for how it decides between a client login and a sub-user login |
| `index.html` | Ticket Scanner — camera-based QR check-in, the default landing page |
| `products.html` | Manual Checkin / List Tickets — search and check in tickets by hand; also where Transfer Ticket and Print Ticket live |
| `dashboard.html` | Today's Dashboard — live showtimes and check-in activity |
| `order.html` | List Orders — search orders, refund/cancel/resend, edit buyer contact info |
| `reports.html` | Event Report — per-showtime reporting with Excel/CSV export (the only export in the app) |
| `insights.html` | AI-driven sales Q&A, admin-only |
| `getMovieInfo.html` | Movie Info Lookup — OMDB-backed movie creation, builds the Square catalog item |
| `getEventInfo.html` | Event Info Entry — same idea for non-movie events |
| `marketing.html` | Marquee Engine — schedules, drafts, approve/edit/send |
| `email-list.html` | Marketing email subscriber management |
| `client.html` | Client Settings — the whole `Client.configuration` control panel, admin-only |
| `user-management.html` | Staff accounts + permissions + per-user data filters |
| `opt-in.html`, `email-signup.html`, `email-unsubscribe.html`, `privacy.html`, `terms.html` | Public, unauthenticated customer-facing pages |
| `signup.html`, `support.html` | Public: self-serve signup for hosted IndieTix (off unless configured), and the support page |

## Auth model

One login form (`POST /api/login`), two outcomes, both driven by the same three fields (`username`, `password`, `clientId`):

- **Client login** — when `username === clientId`, the password is checked against `Client.clientSecret` directly. No `Users` row needed at all; this works the instant a client is onboarded (see `infrastructure/CLIENT_SETUP.md` in the sibling repo). Full access, including pages no permission flag unlocks on its own (Client Settings, User Management).
- **Sub-user login** — otherwise, `username` is looked up in that client's `Users` table and the password checked against its bcrypt hash. Access is gated by five permission flags (`view`, `edit`, `checkIn`, `marketing`, `admin`), default `checkIn` only on a new account.

**Permission enforcement is client-side only, today.** `src/public/header-loader.js`'s `PAGE_ACCESS` map decides what's shown in the UI; backend routes check `requireAuth` (valid JWT) and, for client-only pages, `requireClientAuth` (must be the client login, not a sub-user) — but nothing re-checks the specific `view`/`edit`/`checkIn`/`marketing`/`admin` flags route-by-route. A sub-user with only `checkIn` could call an admin route directly and the backend wouldn't block it on permission grounds. Worth knowing before handing out sub-user accounts to anyone you wouldn't trust with broader access regardless of what the UI shows them.

Each sub-user can also carry a server-side-enforced `DataFilter` (date/event/event-type), used to scope a third party's view down to just their own numbers — see `buildDataFilterWhereClause()` in `src/utils/data-filter-utils.mjs`.

## Layout

```
src/
├── app.mjs                # Main entry -- every route, public and authenticated, thousands of lines
├── local-server.mjs       # Local dev server (`npm start`)
├── serverless.yml         # Serverless Framework config (reference only -- see "Deploying" below)
├── models/                # Sequelize models: client, order, product, user
├── utils/
│   ├── phone.mjs          # E.164 phone normalization
│   ├── sms.mjs            # Centralized SMS send, gated on consent state
│   └── data-filter-utils.mjs  # Builds the server-side WHERE clause for a sub-user's DataFilter
└── public/                # Static assets served from S3/CloudFront -- see the page table above
test/                      # node --test suite, one file per feature area (15 files) -- see Testing below
nodePackages/               # Lambda layer (node_modules for this function's dependencies)
```

## Runtime

- Node.js 22, ES modules — **pin Node 22 specifically**, not whatever `node` resolves to on your PATH. `jsonwebtoken`'s transitive dependency `buffer-equal-constant-time` uses the legacy `SlowBuffer` API, which Node 25 removed outright; this fails identically whether run directly or via a symlinked `node`, a real version incompatibility, not a local setup quirk.
- Express app, packaged for AWS Lambda behind a Function URL (via `serverless-http`); also runnable locally as a plain Express server
- Aurora PostgreSQL (one database per client) via Sequelize + raw `pg` queries — see **Configuration** below for exactly where credentials come from (it's not what the Sequelize model files' own fallback code might suggest)
- JWT auth for operator routes; a handful of public routes (SMS opt-in, password reset, login) are unauthenticated

## Configuration

Two layers, and it's worth being precise about which is which — this app has almost no deployment-level config of its own:

**1. Per-client, pulled live on every request — not environment variables:**
- **Database credentials** come from Secrets Manager at `indieTix/rds/clients/{clientId}/credentials` (`getDatabaseCredentials()` in `app.mjs`), used to open a fresh connection pool per request via `createClientDbConnection(clientId)`. The Sequelize model files (`src/models/*.mjs`) each have their own `if (process.env.DB_HOST)`-gated connection setup — that's dead code in production; no deployment sets `DB_HOST`, so it never runs. Don't be misled by it into thinking a shared `DB_HOST` env var is the real credential source.
- **Everything else** — including `JWT_SECRET` — lives in that client's own `Client.configuration` JSON, loaded by `getClientConfiguration()` and merged into the in-memory `globalConfig` on every request. `JWT_SECRET` is generated uniquely per client at onboarding (see `clientSetup-Teardown`'s `insertClientRecord`) — there is no Lambda-wide JWT secret.

**2. Actual Lambda environment variables** — genuinely deployment-level, not per-client:

| Variable | Purpose |
|---|---|
| `AWS_REGION` | Region for Secrets Manager / S3 / SES clients — also force-re-pinned over whatever `Client.configuration` might (incorrectly) carry for this key, see the comment on `getClientConfiguration()` in `app.mjs` for why |
| `TICKET_SIGNER_ACCESS_KEY` / `TICKET_SIGNER_SECRET_KEY` | Shared IAM credentials for short presigned ticket-PDF URLs — the one deliberate exception to per-client isolation (see the root project's architecture doc for why) |
| `SQUARE_API_BASE` | Optional. Square's API address; unset means production. `https://connect.squareupsandbox.com` for Square's sandbox |
| `SQUARE_APP_ID`, `SQUARE_APP_SECRET_ID`, `SQUARE_OAUTH_REDIRECT_URL` | Optional. Turn on **Connect Square** (OAuth): the app's ID, the Secrets Manager secret holding its secret (plus the environment's webhook key and URL), and this API's `/square/oauth/callback` |
| `HOSTED_SIGNUP_ENABLED`, `CLIENT_SETUP_FUNCTION`, `HOSTED_STATIC_SITE_URL`, `HOSTED_SENDER_EMAIL`, `VENUE_BUCKET_PREFIX`, `HOSTED_TERMS_URL`, `HOSTED_PRIVACY_URL`, `HOSTED_SUPPORT_EMAIL` | Optional. Turn on **self-serve signup** (`signup.html`) and fill in `support.html` |
| `EDGE_ORIGIN_SECRET` | Optional. Set when the API sits behind the CloudFront + WAF edge: requests without the matching `X-IndieTix-Edge` header are refused |

`bootstrap.sh` sets all the optional ones from `bootstrap.config.sh`. They're merged into the function's environment, never put in the SAM template, so variables set by hand (like `TICKET_SIGNER_*`) survive.

**3. `src/public/config.js`** — gitignored, per-deployment, frontend-only. Sets `window.INDIETIX_API_URL` (this Lambda's own Function URL) and `window.INDIETIX_PRINT_AGENT_URL` (optional — the local print agent's LAN address, see the `printer` repo). Copy `config.js.template` and fill in your own values; every page's first `<script>` tag loads this before anything else runs.

No secrets belong in this repo. Real per-client credentials live only in AWS Secrets Manager and each client's database.

## Local development

```
npm install
npm start
```

Runs `src/local-server.mjs` on `$PORT` (default `3000`) — same app code as production, just not wrapped in `serverless-http`. Because DB credentials are pulled from Secrets Manager per-client (not a local `DB_HOST`), your local AWS credentials (whatever the AWS SDK's default credential chain resolves — `aws configure`, env vars, an SSO profile) need real access to a deployed environment's Secrets Manager entries and Aurora cluster to actually log in and browse data locally. There's no "point this at a local Postgres" shortcut for interactive dev, by design — the per-client connection path is the same code production uses. Point a local `config.js` at `http://localhost:3000` to test the real frontend against this local server.

## Testing

```
npm test
```

Runs `node --test test/*.test.mjs` — 15 files covering auth, orders, listing routes, transfers, ticket lifecycle, Square item/showtime creation, Marquee Engine, Insights, password reset, static routes, and the public opt-in/email-signup endpoints. Unlike local dev above, tests don't touch real AWS: they use `aws-sdk-client-mock` for Secrets Manager/S3, `nock` for Square's REST API, and `test-db-harness` for an ephemeral, per-test Postgres 16 container (needs Docker running locally). `sms-utils`, `ticket-pdf-lib`, and `test-db-harness` are `file:../...`-linked sibling repos — clone them alongside this one at the same directory level before running tests.

## Architecture notes worth knowing before you dig in

- **Two upload patterns, deliberately different:** a presigned S3 URL (`POST /api/presigned-upload`) for large files that don't need server-side processing (e.g. a custom poster upload in `getMovieInfo.js`) — bypasses this Lambda's request body entirely; base64 in the JSON body only when the server needs to actually process the image (e.g. marketing post image edits, run through `normalizePosterImage`/`uploadPosterToS3` for resizing). `body-parser`'s limit is raised to `6mb` for the latter, and client-side uploads are capped at 4MB raw to stay under the Lambda Function URL's hard 6MB request payload ceiling after base64 inflation.
- `normalizePosterImage()` / `uploadPosterToS3()` is the shared image pipeline (sharp-based): square mode letterboxes to 600×600; non-square mode caps height at 1000px with `withoutEnlargement`; both set 72dpi output metadata and convert to JPEG.
- `sendEmailWithMultipleAttachments(sender, recipient, subject, body, attachments, html)` is the one real email-sending function (AWS SES v2 + mailcomposer) — reused for ticket confirmations, password resets, and real marketing email sends.
- **Client Settings never sends secrets to the browser.** Passwords, tokens and API keys are write-only: `GET /api/client` lists which are saved (`savedSecrets`), a blank value on save keeps the saved one, and the page's secret boxes stay read-only until **Change** is clicked, so password managers can't fill them.
- **Connect Square and self-serve signup** are bracketed sections in `app.mjs` (`SQUARE OAUTH`, `HOSTED SIGNUP`). Signup links are sealed tokens (AES-256-GCM, `sealToken`/`openToken` in `utils/crypto-utils.mjs`), so venue details never travel readable through Square's sign-in.
- **AWS SDK v2 is still in use** (`AWS.SES`, `s3.getSignedUrlPromise`) alongside v3 clients for newer code — not urgent to migrate, AWS extended v2 support past the original deprecation date.
- **The Marquee Engine marketing subsystem** (`marketing.html`/`.js`, `/api/marketing/*` routes) is split across two repos: the separate `marketingEngine` Lambda expands schedules into `MarketingPost` drafts and runs the 5-minute poller that actually sends approved, due posts across email/Facebook/Instagram/TikTok; this app is where staff review, approve, edit, delete, and (for email only) manually force an immediate send via `POST /api/marketing/posts/:postId/send-now`. `PUT /api/marketing/posts/:postId/approve` is the one human-review checkpoint for every channel — once approved, nothing here has to click "send" again per channel. AI-generated captions (`POST /api/marketing/posts/:postId/regenerate-caption`) are prompted explicitly to avoid obvious "AI tells" (no rhetorical questions, no stock marketing phrases, ≤1 exclamation point, no em dashes).

## Deploying

Real deploys for this platform go through the sibling `infrastructure` repo's `deploy.sh` (`./deploy.sh deploy QRScanner`), not `serverless deploy` — `serverless.yml` in this repo is kept as a reference for what the function needs (runtime, handler, env), not the actual deploy path. `nodePackages/` is this function's Lambda layer (dependencies); `deploy.sh deploy-layer`/`attach-layer` rebuild and reattach it when `package.json` changes. See `infrastructure/UPDATING.md` for a worked example of shipping a change to this repo specifically.
