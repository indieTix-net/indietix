**Last Edited:** 2026-10-28


take the ticket
yes, take the ticket
i feel like we should have the option
to tell them where to stick it

these fees, oh jeeze
paying the price to the monopolies
meanwhile our the sink is broken
and the paint is peeling
cause these fees have hit the ceiling

if it were a little more even 
a little more fair
then maybe we'd be able to give more care
to our building and our pay

so we are starting today
gonna share the free option
no hidden charge, no fine-print trick,
just take the ticket, the fee? Go stick it


# IndieTix

A Square-integrated ticketing platform for independent venues... built to run your own box office without handing a cut of every ticket to a company that had nothing to do with the show.

## Why IndieTix Exists

Most ticketing platforms take too much of a cut.  We consistently see fees from the ticket giants hang in the range of 20% - 30% or more of what the actual base ticket price is. That most of those fees don't go to the people who made the night happen. The artists, musicians, promoters, or venue: very little of the cut goes to them. It goes to a ticketing company that didn't write a note, book a stage, or sweep a floor, but still gets paid like it did.

IndieTix exists to cut that middleman out.

IndieTix was built as tool for one independent event space and cinema trying to run its own box office without handing a slice of every ticket to a company that had nothing to do with the film, the venue, or the night itself. It's grown into a full ticketing platform, but the principle hasn't changed: **the people putting on the show — the venues, the promoters, the artists — should be the ones deciding what a ticket costs**, not a platform with no stake in whether the show is any good. Fees should fund the event, not a stranger's margin.

## What it does

Square handles payment and catalog; IndieTix handles everything around the sale — QR-coded PDF tickets delivered by email and (opt-in) SMS, door check-in via a web scanner, box-office reporting, event and cinema creation and scheduling, a marketing scheduler that posts to email/Facebook/Instagram/TikTok, and an admin console for managing it all. Each venue (client) is fully isolated: its own database, its own S3 buckets, its own Square credentials, its own SMS campaign — share-nothing multi-tenancy, not a shared pool with row-level permissions.

IndieTix is free, open source, and yours to self-host and modify with no strings attached — no tier that unlocks "real" control, no cut of your ticket sales baked into the code. If you'd rather not run the infrastructure yourself or need help, hosted and supported plans are available too; that's how this stays maintained and keeps improving, not a toll on using it. Either way, the pricing decisions stay where they belong — with you.

## Highlights

- **Movies *and* events.** Movies come in through an OMDB lookup that pre-fills title, rating, runtime, cast, and plot; concerts, comedy, trivia nights, private rentals, and anything else come in through a plain event form. Each item can carry as many showtimes as you want, on whatever schedule you want — a one-night show, a week-long run, a matinee-plus-evening split — and each showtime is just a Square modifier, so it sells at your register and online the same way. Past showtimes expire and finished runs archive themselves.
- **One catalog, one source of truth.** IndieTix doesn't keep its own item catalog. Your POS already has one, and two catalogs that are supposed to agree eventually won't. Square owns items, prices, and payments. IndieTix creates the Square items for you and reacts to the sales.
- **Paper tickets, the old-school way.** An optional little print agent drives a networked Brother label printer straight over TCP: no drivers, no print dialogs, no Windows-only SDK. Hit **Print Ticket** and a real stub comes out at the box office, the kind of thing a ticket-collecting regular actually keeps. It fits an indie house a lot better than a QR code on a phone does.
- **Any phone is a ticket scanner.** You don't need specialized scanning hardware or an app. Any phone, tablet, or laptop with a camera opens the scanner in its browser and starts checking people in. The scanner picks the rear camera on its own and can play a sound on each scan, and auto check-in means staff don't have to tap anything. Need another person on the door on a busy night? Hand them a phone and log them in with a check-in-only account. A cheap USB or Bluetooth handheld scanner also works if you already own one, because it types into the manual check-in search like a keyboard.
- **Whole platform from one script.** `./bootstrap.sh up` stands up every piece of infrastructure and onboards your first venue. `./bootstrap.sh down` tears it all back out. More on that [below](#setup--deploy).
- **Spending guard rails built in.** Set one email address in the config and the deploy also sets up AWS Budgets that warn you when daily or monthly spend goes over your limit. For a sandbox, it can also add a breaker that shuts the environment off if the daily limit is blown, plus one-line commands to trip it, reset it, and check it. More [below](#infrastructure).
- **As many venues as you need, on one deployment.** Each Square account is one IndieTix "client." Own two locations with two Square accounts? Two clients on the same infrastructure, fully isolated from each other. Want completely separate environments (production + a sandbox, or one per business)? Give each its own `ENV_PREFIX` and they can live side by side in the same AWS account without colliding.
- **Self-discovering.** New clients are found automatically: incoming Square webhooks are routed by merchant ID, and the inbound-SMS handler discovers clients from Secrets Manager. Onboarding a venue never needs a redeploy.
- **A public API, included.** A small, documented REST API lets the tools around your venue use your data: a promoter's dashboard, your website, a third-party door scanner. Keys are scoped (buyer contact info is its own scope), can be limited to one promoter's events, are rate-limited, and are stored only as hashes. There's no paid tier; it ships with the self-hosted app. See [FUNCTIONALITY.md](./FUNCTIONALITY.md#public-api).
- **Everything else in the box.** Email + opt-in SMS ticket delivery, a phone-friendly door scanner, staff accounts with server-enforced permissions and per-promoter data filters, refunds/transfers/resends, nightly box-office reporting (BDOR/EBOR) over SFTP/FTP, plain-English analytics, and a marketing scheduler for email/Facebook/Instagram/TikTok. See [FUNCTIONALITY.md](./FUNCTIONALITY.md) for the full tour.

## Architecture: why it's cheap, small, and boring (on purpose)

IndieTix is built from managed AWS services and nothing else. That means no servers to patch, no containers to babysit, and no third-party SaaS in the middle of your money.

| Piece | AWS service | Why |
|---|---|---|
| All backend logic | **Lambda** (Node 22) | Pay per request. An indie venue's traffic costs pennies, and there's no idle server sitting around waiting to be attacked. |
| Data | **Aurora PostgreSQL Serverless v2** | One database per venue. Scales down to half a unit when it's quiet. Storage is encrypted, it lives in private subnets with no public endpoint, and automated backups give you point-in-time restore. |
| Tickets, posters, the web app's files | **S3 + CloudFront** | Static files from a CDN, and ticket PDFs handed out through short-lived, read-only presigned links. |
| Square webhook intake | **API Gateway → SQS (FIFO)** | Tells Square "got it" right away, then the real work happens asynchronously and in order. |
| Two-way SMS | **AWS End User Messaging + SNS** | 10DLC-compliant, with a separate campaign, number, and opt-out list for each venue. |
| Credentials | **Secrets Manager** | Nothing secret lives in code or in the repo. |
| Cost controls (optional) | **AWS Budgets → SNS → Lambda** | Daily and monthly budgets email you when spend runs high. Over the daily limit, an optional breaker sets every Lambda in the environment to zero concurrency, so nothing can run up a bill until you reset it. |
| Logs + monitoring | **CloudWatch** | Every Lambda logs the raw incoming event first, so debugging starts from the actual input, not a guess. Alarms, metrics, and Lambda Insights come built in. |

**What it costs to run.** At rough AWS list prices, the always-on floor for one environment is about **$80–100/month**. Most of that is the Aurora minimum capacity (~$45) and the NAT gateway that lets the private Lambdas reach AWS APIs (~$35). Lambda, SQS, SNS, S3, and CloudFront for a single venue's traffic usually come to a few dollars. Add about $0.40/month per Secrets Manager secret. That floor is shared by every venue on the deployment, so a second or third venue costs almost nothing extra. Compare that to 20–30% of every ticket. (Prices depend on region and change over time; check AWS's pricing pages for your own numbers.)

**A small attack surface.** The only things reachable from the internet are the Square webhook endpoint (every request is signature-verified), the web app's Lambda Function URL (which also serves the public API), and the static site on CloudFront. There are no SSH boxes and no always-on servers. The database can't be reached from outside its VPC. Each venue gets its own database user, so one venue's credentials can't open another venue's data. Inside a venue, every route checks the caller's permissions on the server, and API keys only reach the scopes they were given.

**Isolation, honestly stated.** Each venue's *data* is never shared: separate database, separate S3 buckets, separate Secrets Manager entry, separate Square credentials, separate SMS campaign and opt-out list. A few things that can be shared by the venues on one deployment, and they're all plumbing rather than storage:
- the Square webhook queue (messages are routed to the right venue by merchant ID)
- the inbound-SMS topic (routed by the number that was texted)
- the Aurora cluster itself (the compute, not the data; each venue still gets its own database and user)
- one read-only signing credential that can only fetch already-generated ticket PDFs

If you want even that separated, give the venue its own `ENV_PREFIX` environment and you have a truly share nothing environment.

**A simple Express app that's meant to stay simple.** The operator UI, its backend, and the public `/v1` API are one Express app (`QRScanner`) running on Lambda, with a plain HTML/JS/CSS frontend: no framework, no build step, nothing to compile. A new contributor can read it front to back in an afternoon. Keeping it that way is a goal, not an accident.

## Setup & Deploy

For what the platform actually does day to day, see [FUNCTIONALITY.md](./FUNCTIONALITY.md). For the full step-by-step on bringing up a venue from nothing, see [CLIENT_SETUP.md](./CLIENT_SETUP.md). For worked examples of changing the infrastructure after it's running — fixing a Lambda, adding config, updating a shared layer — see [UPDATING.md](./UPDATING.md).

### Before you start: what you'll need

**Installed on your machine** (macOS or Linux; on Windows, use WSL):

| Tool | Used for |
|---|---|
| **AWS CLI v2** | Every AWS call both scripts make. |
| **AWS SAM CLI** | Deploying the 12 CloudFormation stacks (`sam deploy`). Docker is *not* required. |
| **Node.js 22 + npm** | Building the Lambda layers (`npm install`) and linting every build (`node --check`). Use the same major version Lambda runs. |
| **Python 3** | `bootstrap.sh` uses it to safely build the first-client onboarding payload. |
| **bash, zip, unzip, diff, curl** | Already installed on macOS and almost every Linux distribution. The scripts are written to work with macOS's built-in bash 3.2. |
| **git** | Cloning the repo (see below). |

**The code.** Everything lives in one repo. `infrastructure/` builds each Lambda straight from its sibling folder one level up, under the exact folder names the repo already uses, so clone it as-is:

```bash
git clone https://github.com/indieTix-net/indietix.git indieTix
cd indieTix/infrastructure
```

**One-time AWS setup:**

1. **An AWS account.** A dedicated account for IndieTix is cleanest. You can also use a second account as a sandbox for testing changes before they reach production (`deploy.sh deploy-dev`).
2. **Credentials for the CLI.** Create an IAM user (or an IAM Identity Center/SSO login) that can create the resources the stacks use: CloudFormation, Lambda, IAM roles, RDS/Aurora, EC2 networking (subnets, NAT gateway, security groups), S3, CloudFront, SQS, SNS, API Gateway, Secrets Manager, EventBridge, and CloudWatch Logs. Administrator access in a dedicated account is the simplest place to start. Then run `aws configure` (or `aws configure sso`). If you use a named profile, set `AWS_PROFILE` in `bootstrap.config.sh`.
3. **Pick a region** and use it everywhere: in `bootstrap.config.sh`, in SES, and in End User Messaging if you add SMS later.
4. **Find your VPC and two subnets.** The account's default VPC works fine. You need its ID, plus two of its subnets in *different* availability zones:
   ```bash
   aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text
   aws ec2 describe-subnets --filters Name=vpc-id,Values=<that-vpc-id> \
     --query 'Subnets[].[SubnetId,AvailabilityZone,CidrBlock]' --output table
   ```
   These go into `DEFAULT_VPC_ID`, `SUBNET_ID_A`, and `SUBNET_ID_B`. If this isn't the first IndieTix environment in that VPC, also choose non-overlapping `PRIVATE_SUBNET_A_CIDR`/`B_CIDR` values.
5. **Set up SES for email.** Ticket emails, resends and password resets all go out through Amazon SES, and none of this is created by `bootstrap.sh`:
   - **Verify your sending domain** (for example `yourvenue.com`) in the same account and region as the environment, with **Easy DKIM**. SES gives you three CNAME records to add to your domain's DNS. Verifying the whole domain lets you send from any address on it, and DKIM keeps your tickets out of spam folders. A DMARC record on the domain helps too.
   - **Request production access** (SES console → Account dashboard → Request production access, or `aws sesv2 put-account-details`). Until it's granted, SES only delivers to addresses you've verified yourself, so real customers won't get their tickets. AWS reviews the request by hand, usually within a day, so start early. Describe the mail honestly: transactional ticket emails to people who just bought a ticket.
   - **Both are per account *and* per region.** A sandbox environment in a second account or region needs its own domain verification and its own production access request. If your sandbox is a member account in an AWS Organization, reach it in the console with **Switch role** (`OrganizationAccountAccessRole`), and check the account number in the top-right corner before you click through the SES setup wizard. It's easy to end up setting things up in the wrong account.
   - Set the venue's `SENDER_EMAIL` in Client Settings to an address on the verified domain.
6. **A Square developer account** with an application created, so you have an access token for your first venue. Onboarding requires it; see [Connecting Square](#connecting-square) below.

**Outside services `bootstrap.sh` doesn't set up for you.** Everything on AWS that a venue needs to sell and deliver tickets comes up with `./bootstrap.sh up`, except SES (above). The rest are separate accounts, registrations or keys, and most are optional:

| Service | Needed for | Required? | Where it's covered |
|---|---|---|---|
| **Square** developer app, access token, and webhook | Selling tickets at all | Yes | [Connecting Square](#connecting-square) |
| **Amazon SES** domain verification and production access | Emailing tickets | Yes | Step 5 above |
| **10DLC registration** in AWS End User Messaging, plus a phone number | Texting tickets | No, and it can come much later | [Setting up SMS (10DLC)](#setting-up-sms-10dlc) |
| **Privacy policy and terms pages** | 10DLC approval (carriers check them) | Only for SMS | [Setting up SMS (10DLC)](#setting-up-sms-10dlc) |
| **Google Cloud** project and service account | Pushing showtimes to Google Calendar | No | [Connecting Google Calendar](#connecting-google-calendar) |
| **Meta** (Facebook/Instagram) and **TikTok** developer apps | Marquee Engine social posts | No | [Connecting Social Media](#connecting-social-media-facebook-instagram-tiktok) |
| **Anthropic API key** (`ANTHROPIC_API_KEY`) | Insights (plain-English questions) and AI-written marketing captions | No | Paste it into Client Settings. Usage is billed by Anthropic. |
| **OMDB API key** (`OMDB_API_KEY`) | Movie lookup on Add Movie (title, rating, cast, plot, poster) | Yes, for movies | Free key from omdbapi.com. Paste it into Client Settings. It stays on the server; the browser never sees it. |
| **FTP/SFTP accounts** at your box office reporting services (e.g. Rentrak/comScore) | Nightly box office reports | No | `FTP1_*`…`FTP3_*` in Client Settings; set `USE_FTP` to `true` to turn delivery on |
| **A Brother label printer** at the venue | Printed ticket stubs | No | [Printing Tickets](#printing-tickets) |
| **AWS Cost Anomaly Detection** | An extra email when spend jumps unexpectedly | No | One-time setup in the Billing console. It's account-wide, so it isn't part of any environment's stacks. |

**Have the keys already? Let `up` enter them.** The accounts above still need a human, but once you have the keys and credentials, `bootstrap.sh` can hand them to your first venue at onboarding instead of you typing each one into Client Settings afterwards:
- Copy `first-client-settings.json.template` to `first-client-settings.json` (gitignored) and fill in what you have: OMDB, the Google service account key (as JSON) and calendar IDs, `ANTHROPIC_API_KEY`, FTP destinations, social media tokens, `OWNER_BCC_EMAIL`, and so on. Blank values are skipped, so the defaults stay.
- Set `FIRST_CLIENT_SETTINGS_FILE="first-client-settings.json"` in `bootstrap.config.sh`.
- Keys use the same names Client Settings does, and only keys Client Settings can edit are accepted. Anything else is skipped and named (never its value) in the onboarding log, so a typo shows up. Square credentials come from `bootstrap.config.sh` instead, and win if the file has them too.
- It applies when the venue is first onboarded, i.e. on a fresh `up`. After that, change things in Client Settings. The onboarding payload, secrets included, goes to the Lambda from a temporary file only you can read, never on the command line.

### Infrastructure

The whole platform is defined as 13 AWS SAM (CloudFormation) stacks in this repo (plus two optional ones: the cost guard and the API firewall), and `bootstrap.sh` deploys all of them in dependency order into a fresh AWS account/region. This has been proven end-to-end against a clean sandbox account.

**Bring an environment up:**

```bash
cd infrastructure
cp bootstrap.config.sh.template bootstrap.config.sh   # gitignored, holds your real values
# edit bootstrap.config.sh: ENV_PREFIX, region, VPC/subnets, first venue's details
./bootstrap.sh up
```

`up` deploys the networking and Aurora cluster, then storage and the CloudFront static site, the Square webhook queue, the shared layers (built fresh from source and published into *your* account), all ten Lambdas (each synced from its real source repo right before it deploys, so nothing stale gets shipped), and the inbound-SMS topic. It also seeds a ticket-template bucket with generic placeholder tickets, onboards your first venue, and pushes the web app's static files. With `SQUARE_WEBHOOK_AUTO="true"` it also creates the Square webhook subscription for you (see [Connecting Square](#connecting-square)). At the end it prints your live URLs plus the short list of things that need a human on the other end: SES sender verification, registering the webhook in Square if you didn't let `up` do it, and optionally Google/social/SMS accounts.

Optional features, each switched on in `bootstrap.config.sh` and applied by `up` (see [Connecting Square](#connecting-square) and [API firewall](#api-firewall-optional)):

| Setting | What it turns on |
|---|---|
| `SQUARE_ENVIRONMENT="sandbox"` | Points every Square call at Square's sandbox (fake sellers and money), for testing. Default `"production"` |
| `SQUARE_APP_ID`, `SQUARE_APP_SECRET` | **Connect Square**: venues connect with Square's sign-in instead of pasting a token, and a daily job keeps their access fresh |
| `HOSTED_SIGNUP="true"` (+ `HOSTED_SENDER_EMAIL`, `HOSTED_TERMS_URL`, `HOSTED_PRIVACY_URL`, optional `HOSTED_SUPPORT_EMAIL`) | **Self-serve signup** at `<site>/signup.html`: any Square seller can create a venue, with no one running `add-client` |
| `API_EDGE="true"` | **API firewall**: CloudFront + WAF in front of the QRScanner API |
| `OPERATOR_ALERT_EMAIL` | Who's copied on Connect Square renewal failures (default: `BUDGET_ALERT_EMAIL`) |

Always on: `up` gives QRScanner and client teardown the static site's bucket name (`STATIC_SITE_BUCKET`), which turns on **logo upload** in Client Settings. Every venue in an environment shares the static site, so each venue's logo goes in its own `venue-logos/<clientId>/` folder, and removing a venue deletes that folder.

It's safe to re-run. CloudFormation only applies what changed, and a stack left behind by a failed earlier attempt gets cleaned up and retried automatically. With `SQUARE_WEBHOOK_AUTO="true"`, one run is enough. Without it, the usual flow for a first-timer is: run `up` once, take the webhook URL it prints over to Square to get a signature key, add that key to the config, and run `up` again.

**Tear it down:**

```bash
./bootstrap.sh down
```

`down` removes the whole environment. It asks for confirmation first, and it can't be undone. In order, it:
0. with `SQUARE_WEBHOOK_AUTO="true"`, deletes this environment's Square webhook subscription (only if it still points at this environment), so Square stops sending events to an endpoint that's about to disappear. It also deletes the Connect Square app secret, if there is one
1. finds every venue in the environment, by checking which client secrets point at this environment's database cluster
2. offboards each venue: drops its database, deletes its secrets (including a Connect Square refresh token), and removes its S3 buckets
3. empties the remaining buckets so CloudFormation can delete them
4. deletes all 13 stacks (plus the optional cost guard and API firewall, the latter in us-east-1) in reverse dependency order, the Aurora cluster included. Before the Aurora stack, it waits for AWS to release the network interfaces the deleted Lambdas leave behind, which otherwise block the database's subnets from deleting.
5. removes what bootstrap created outside CloudFormation: the ticket-template bucket, the published shared layers, and the environment's Lambda log groups

Only resources belonging to that `ENV_PREFIX` are touched. Other environments in the same account are left alone.

**Keep a sandbox cheap (optional):**
- `AURORA_MIN_CAPACITY="0"` lets an idle sandbox's database pause itself after 5 minutes with no connections. It wakes automatically on the next connection, and that first request waits about 15 seconds. That takes one idle sandbox from about $3.30/day to about $1.30/day; the rest is the NAT gateway. Leave it at `0.5` for a real venue.
- Set `BUDGET_ALERT_EMAIL` and `up` also deploys a **cost guard**: AWS Budgets that email you when daily spend passes `BUDGET_DAILY_USD` (default $5) or monthly spend nears `BUDGET_MONTHLY_USD` (default $120). Budgets measure the whole AWS account, and AWS billing data lags by a few hours.
- With `BUDGET_BREAKER="true"`, going over the daily budget also **blocks every request** to the environment: all its Lambdas are set to concurrency 0, so AWS rejects every call. Square retries rejected webhooks for up to 72 hours and queued orders wait, so nothing is lost. Turn it back on with `./bootstrap.sh unblock`; check with `./bootstrap.sh breaker-status`; trip it by hand with `./bootstrap.sh block`. **Sandbox only.** It takes the door scanner and ticket delivery offline, so never enable it for a live venue.

**Add or remove a venue on an existing environment:** invoke the deployed `<env-prefix>-client-setup-teardown` Lambda. Onboarding creates the venue's database, schema, database user, Secrets Manager entry, and S3 buckets in one call. The same Lambda with `"delete_flag": true` and the venue's `username` removes them again. [CLIENT_SETUP.md](./CLIENT_SETUP.md) has the full payload.

**Ship code changes:** `deploy.sh` (see [DEPLOY.md](./DEPLOY.md)) is the day-to-day tool once an environment exists. It lints every build, diffs it against what's actually live, and asks before touching production. `./deploy.sh deploy-dev <repo>` sends the same build to a sandbox environment first, with no prompt. Copy `deploy.config.sh.template` to `deploy.config.sh` before using it.

### Connecting Square

IndieTix reads orders and catalog items from Square via API access + webhooks. There are two ways for a venue to connect:

- **A personal access token** (below): the venue's own Square application token, pasted into Client Settings. Simplest for a single self-hosted venue; it's how Liberty Hall runs.
- **Connect Square (OAuth)**: one IndieTix Square application per environment, and each venue signs in with Square to connect. Needed for self-serve signup and the Square App Marketplace. See [Connect Square and self-serve signup](#connect-square-and-self-serve-signup) after these steps.

1. **Create a Square application.** In the Square Developer Dashboard, create a new application and generate an access token. Note your **Location ID** too.
2. **Set up the webhook.** The subscription has to point at your deployed `square-queue-forwarder` endpoint and be subscribed to **`payment.updated` only**. Don't add `payment.created`; IndieTix only acts on completed payments, which arrive as `payment.updated`.
   - **Let `bootstrap.sh` do it (recommended for an environment it owns).** In `bootstrap.config.sh`, set `SQUARE_WEBHOOK_AUTO="true"`, put the application's access token in `FIRST_CLIENT_SQUARE_ACCESS_TOKEN`, and set `SQUARE_EXPECTED_MERCHANT_ID` to the merchant that token belongs to. `up` then:
     - checks the token's merchant against `SQUARE_EXPECTED_MERCHANT_ID` and stops, changing nothing, if they differ
     - creates the subscription named `SQUARE_WEBHOOK_NAME` (default: your `ENV_PREFIX`), or updates its URL and events if it already exists. No other subscription on the app is touched, and re-running is safe.
     - passes its signature key, the webhook URL, and the location (the merchant's only active one, or `FIRST_CLIENT_SQUARE_LOCATION_ID`) straight into the first venue's onboarding, so step 3 is already done for that venue

     `down` deletes that subscription again, but only if it still points at this environment. Subscriptions belong to the Square *application*, so this needs the application's own access token. An OAuth token a merchant granted the app can't manage them.
   - **Or by hand,** in the Square Developer Dashboard under Webhooks. Square generates a **Signature Key** for the subscription. Copy it.
3. **Enter your credentials in IndieTix's Client Settings** (already done for a bootstrap venue with `SQUARE_WEBHOOK_AUTO`): `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_SIGNATURE_KEY`, and `SQUARE_WEBHOOK_URL` (must exactly match the subscription's URL — it's part of the signature check).
4. **Create three custom attribute definitions in Square** (Items & Orders → Custom Attributes):
   - A **Yes/No** attribute flagging ticketed items (defaults to the name `UseQRCode`, configurable via `USE_QR_CODE`)
   - A **Selection** attribute for **Distributor**, with your venue's own list of distributors (`DISTRIBUTOR_NAME`)
   - A **Selection** attribute for **Event Type**, with whatever categories fit your venue (`EVENT_TYPE`)
5. **Create your first movie or event through IndieTix's own Add Movie / Add Event pages** — they build the Square item, attributes, and showtimes for you. No need to hand-build items in the Square dashboard.

#### Connect Square and self-serve signup

1. **In the Square Developer Dashboard,** create one IndieTix application. It has separate sandbox and production credentials; use the ones matching `SQUARE_ENVIRONMENT`.
2. **In `bootstrap.config.sh`:** `SQUARE_APP_ID` (the Application ID) and `SQUARE_APP_SECRET` (the Application Secret; this file only, never commit it). Keep `SQUARE_WEBHOOK_AUTO="true"`, with that application's own access token as `FIRST_CLIENT_SQUARE_ACCESS_TOKEN`: every connected venue's events arrive on this environment's one subscription, which then also listens for `oauth.authorization.revoked`.
3. **Run `./bootstrap.sh up`.** It stores the app secret in Secrets Manager (`indieTix/square/app/<ENV_PREFIX>`), switches Connect Square on in QRScanner and the daily `square-token-refresher`, and prints an **OAuth redirect URL**.
4. **Register that redirect URL** in the Developer Dashboard, under your app's OAuth settings.

Venues then see **Connect Square** in Client Settings. What happens behind it:
- The access token goes where a pasted token would. The refresh token stays only in Secrets Manager (`indieTix/square/clients/<venue>`).
- `square-token-refresher` renews each token about weekly; Square's expire after 30 days. If it fails, it emails the venue and `OPERATOR_ALERT_EMAIL`.
- If a venue removes IndieTix in Square, it's flagged, emailed once, and shown **Reconnect Square**.

**Self-serve signup:** add `HOSTED_SIGNUP="true"` and `HOSTED_SENDER_EMAIL` (an SES-verified From address). Add `HOSTED_TERMS_URL` and `HOSTED_PRIVACY_URL`, https:// links to your hosted service's own published Terms and Privacy Policy: signing up means agreeing to them, so the signup page links both, and `up` refuses to turn signup on without them (only a `SQUARE_ENVIRONMENT="sandbox"` test environment may leave them blank). Optionally add `HOSTED_SUPPORT_EMAIL` (shown on `support.html`). Then:
1. `<site>/signup.html` asks for a venue name, contact and Terms acceptance, then sends the person through Square's sign-in.
2. The venue is created in the background, exactly as onboarding does, with the Square merchant ID as its ID.
3. The contact gets a welcome email with a one-time link to set the main login's password.

`up` refuses `HOSTED_SIGNUP` without Connect Square and `SQUARE_WEBHOOK_AUTO`. Leave it off for a self-hosted install.

### API firewall (optional)

`API_EDGE="true"` puts the QRScanner API (logins, signup, password resets, the Square sign-in) behind **CloudFront and an AWS WAF**. A Lambda Function URL can't take a WAF directly. The firewall:
- blocks more than 100 requests per 5 minutes from one address to login, signup, password and Square sign-in routes, and more than 3,000 per 5 minutes overall
- applies AWS's IP reputation, common-exploit and known-bad-input rule sets

It costs about $10 a month, and always deploys in us-east-1 (stack `<ENV_PREFIX>-api-edge`), where CloudFront firewalls live. CloudFront adds a secret header (kept in Secrets Manager, `indieTix/edge/<ENV_PREFIX>`, us-east-1), and QRScanner refuses requests without it, so nothing can go around the firewall to the Function URL. `up` prints the new **API address**: put it in `config.js` (`INDIETIX_API_URL`). With Connect Square on, it's also the OAuth redirect URL's base, so register the new redirect URL with Square.

### Error alarms and status page

With an alert email set (`ALARM_EMAIL`, else `OPERATOR_ALERT_EMAIL` or `BUDGET_ALERT_EMAIL`), `up` deploys `<ENV_PREFIX>-alarms`: CloudWatch alarms that email you when ticket orders fail or back up in the queue, the Square webhook or QRScanner returns errors, or a background job crashes, and again when each recovers. Click the confirmation link AWS emails first. The same alarms drive the public **status page**, `status.html` on the static site, which shows each part of IndieTix as working or having a problem (never alarm names or details). Alarms cost about $0.10 each a month.

### Connecting Google Calendar

Optional — pushes a calendar event for every showtime when you add a movie or event.

1. Create a Google Cloud project, enable the **Calendar API** and **Drive API** (Drive is used for the poster image).
2. Create a **service account**, generate a JSON key — treat it like a password, never commit it.
3. Create two Google Calendars (or reuse one) — movies and general events — and share each with the service account's email, with **"Make changes to events"** permission.
4. In Client Settings, paste the full JSON key into **Google Service Account Key**, and enter each calendar's ID into **Cinema Calendar ID** / **Event Calendar ID**.
5. Check **"Create calendar events"** when adding a movie/event to push showtimes automatically.

### Connecting Social Media (Facebook, Instagram, TikTok)

Optional, part of the Marquee Engine. No admin UI for these yet — they're set directly on your venue's config in the database for now.

**Facebook & Instagram:** create a Meta app, generate a Page Access Token, connect your Instagram Business account to the Page. Set `META_PAGE_ACCESS_TOKEN` + `META_PAGE_ID` for Facebook; additionally set `META_IG_BUSINESS_ID` for Instagram.

**TikTok:** create an app in the TikTok for Developers portal, apply for Content Posting API access (requires an app audit), then go through TikTok's OAuth flow as the venue's account to get an access token + refresh token. Set `TIKTOK_ACCESS_TOKEN` and `TIKTOK_REFRESH_TOKEN` from that exchange, plus `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` (your app's own credentials, not per-token). TikTok's access tokens only last ~24h — with all four of those set, the Marquee Engine poller automatically refreshes (and re-persists) the token pair before every send, so you only have to do this OAuth exchange once rather than re-pasting a token daily. Optionally set `TIKTOK_PRIVACY_LEVEL` to match an approved privacy option — otherwise it auto-falls-back to whatever your account is actually approved for.

Each channel works independently — you only need the keys for the ones you're actually using.

### Setting up SMS (10DLC)

Optional. Tickets sell and arrive by email without it. US carriers only deliver application text messages from registered **10DLC** campaigns, and every venue gets its own campaign, phone number and opt-out list. That keeps one venue's STOP replies, or one venue's compliance problem, from ever affecting another. `bootstrap.sh` deploys the code that handles inbound texts (the `<env-prefix>-sms-inbound` Lambda and its `<env-prefix>-inbound-sms` SNS topic). The registration and the number are yours to set up, in **AWS End User Messaging** in the same account and region:

1. **Publish a privacy policy and terms of service** where carriers can read them, and set `INDIETIX_PRIVACY_URL` and `INDIETIX_TERMS_URL`. QRScanner ships `privacy.html` and `terms.html` you can adapt. Carriers look specifically for language saying mobile opt-in data won't be shared.
2. **Register a brand and a campaign** for the venue in End User Messaging. That covers the business details, sample messages, and how customers opt in (the opt-in page IndieTix provides). Approval usually takes one to four weeks. Expect small monthly carrier and registration fees per campaign.
3. **Once the campaign is approved,** request a 10DLC phone number for it, create an opt-out list for the venue and attach it to the number, and set the STOP/HELP/START keyword replies with the venue's name. AWS sends those replies itself, so they still go out to someone who has opted out.
4. **Turn on two-way SMS** for the number, sending inbound messages to the `<env-prefix>-inbound-sms` SNS topic. That's how a STOP text reaches IndieTix and revokes the customer's consent in the venue's own database.
5. **In Client Settings,** fill in `SMS_CAMPAIGN_ID`, `SMS_ORIGINATION_NUMBER` and `SMS_OPT_OUT_LIST_NAME`, then set `SEND_SMS` to `true`. From then on, ticket emails offer customers a "get your tickets by text" link, and customers who opt in get their tickets texted.

### Printing Tickets

Optional. By default, customers get their ticket by email (and by text, if SMS is enabled) — nothing to set up. Some venues also want to hand a printed ticket stub to a customer standing at the door. That's a separate piece: a small local print agent (the [`printer`](../printer) folder) that runs on a computer at the venue and talks to a network-connected Brother QL label printer (QL-820NWB or compatible) over the LAN.

1. Buy a network-connected Brother QL printer, connect it to the venue's WiFi/Ethernet, and set a DHCP reservation for its IP on your router.
2. Run the `printer` agent on any always-on computer on the same local network (a till computer or a small dedicated box works) — see its README for setup.
3. Set `window.INDIETIX_PRINT_AGENT_URL` in QRScanner's `config.js` to the agent's LAN address (e.g. `http://192.168.1.42:9191`).

Once configured, a **Print Ticket** action appears in the Products page's action menu, next to View Ticket — it sends the same ticket PDF straight to the label printer. Leave `INDIETIX_PRINT_AGENT_URL` unset for any venue that doesn't want this; the action simply won't appear.

## Tests, CI, and contributing

### The test suites

Every service folder has its own test suite, about 500 tests in total, run with Node's built-in test runner (`node --test`). No Jest and no extra framework.

| Repo | Tests | Repo | Tests |
|---|---|---|---|
| QRScanner | ~229 | sms-utils | ~24 |
| marketingEngine | ~83 | DailyPgQueryAndSftp | ~22 |
| smsOptInOptOut | ~39 | clientSetup-Teardown | ~19 |
| expireQRCodeSquareModifiers | ~30 | clientReporting / ticket-pdf-lib | ~13 each |
| getSquareOrders | ~24 | square-queue-forwarder / test-db-harness | ~9 each |

How the tests are built:
- **Real Postgres, not mocks.** Most of this platform's correctness lives in SQL: the box-office reporting functions, the JSON config, and referential integrity enforced in app code. The shared `test-db-harness` package starts a throwaway `postgres:16` Docker container per test run (matching Aurora's engine version). Tests build the real client schema in it using `clientSetup-Teardown`'s own `createDatabaseObjects`, so the tests and production read the schema from the same place.
- **Nothing real gets touched.** AWS calls are mocked with `aws-sdk-client-mock`, and Square's API is intercepted at the HTTP level with `nock`. The test container only listens on `127.0.0.1`. No test needs AWS credentials or can reach a real database, bucket, or phone number.

**Running them locally:** you need the [prerequisites](#before-you-start-what-youll-need) above, plus **Docker** running. Clone the repo (see above), then for any folder:

```bash
cd getSquareOrders
npm install
npm test
```

Shared packages (`sms-utils`, `ticket-pdf-lib`, `test-db-harness`, and `clientSetup-Teardown` for the schema) are pulled in from their sibling folders, which is one more reason the folder names have to match exactly.

### Continuous integration (GitHub Actions)

One workflow, `.github/workflows/test.yml` at the repo root, runs on **every push to `main` and every pull request against `main`**. It works out which folders the change touched and runs each affected test suite in its own job: it sets up Node 22, installs the suite's sibling packages and its own dependencies, then runs `npm test`. A change to shared code (`sms-utils`, `ticket-pdf-lib`, `test-db-harness`, or the schema in `clientSetup-Teardown`) re-runs every suite that depends on it. **Run workflow** on the Actions tab tests everything.

Docker comes preinstalled on GitHub's Ubuntu runners, so the throwaway Postgres containers work there with no extra setup. A typical run takes 2–3 minutes.

Two folders aren't covered yet. `infrastructure` has no CI; `deploy.sh` lints every build itself, and `bootstrap.sh` is tested by actually running it against a sandbox account. `printer` has no tests, because it drives physical hardware.

### Branching and pull requests

- **`main` is always deployable.** Whatever is on `main` should be safe to ship to production.
- **Work on a branch** named for what it does, like `fix/sms-timezone` or `feature/stripe-plugin`. Open a pull request against `main`.
- **CI must pass** before merging. CI picks which suites to run from the folders you touched, including everything downstream of shared code, so a green run covers the whole change.
- **Keep PRs small and focused.** Change existing code in place rather than restructuring it, and put new features in their own clearly commented block, so the diff is easy to review.
- **Schema changes must be safe to re-run.** Use `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`, and update `createDatabaseObjects` (for new venues) and `migrations.sql` (for existing ones) together.
- **Never commit secrets.** Credentials belong in Secrets Manager or a venue's `Client.configuration`, never in code, READMEs, or example snippets.
- **Deploying after merge:** prove it in a sandbox first (`./deploy.sh deploy-dev <repo>`), then run `./deploy.sh deploy <repo>`, which shows a diff and asks before touching production. Ship changes to the customer-facing Lambdas (`getSquareOrders`, `QRScanner`) on a quiet weekday, never right before a big show night or weekend. Merging and deploying are separate steps on purpose: a merged PR doesn't deploy anything by itself.

Branch protection (required CI checks, no direct pushes to `main`) gets turned on once the repo is public. GitHub only offers it for free on public repos.

## Where it's headed

- **Other POS systems.** Square was a deliberate choice, not a hard requirement. The original goal was to avoid running an item catalog at all and to never end up with two catalogs that disagree, so IndieTix uses whatever catalog the venue's POS already has. That same pattern carries over to other systems: a **Stripe** or **Lightspeed** plugin would handle the catalog/webhook/order layer for that POS, while tickets, the door scanner, reporting, SMS, and marketing stay exactly as they are. An **IndieTix-native** checkout is also on the table for venues that have no POS at all.
- **Query performance at higher volume.** Nothing has been tuned for scale yet. At one venue's volume it hasn't needed to be, and Aurora Serverless has plenty of headroom to scale up if it ever does. Scaling hardware isn't the first fix, though. The data model is deliberately simple (orders, tickets, and a join table), so the real work is in the queries themselves: checking that they use indexes (`EXPLAIN ANALYZE` on the busy ones, especially anything that filters by showtime date, event name, or QR code) and adding indexes where they don't. A few pages also pull a lot of data at once; the ticket and order lists in particular load far more rows than a person can look at. Those need server-side paging and narrower queries before a venue selling thousands of tickets a week would feel them. This is next on the list.
- **Smaller items already on the list:** a rate-limiting WAF in front of the public endpoints, an SMS spend circuit breaker, and a direct number-to-venue routing table for inbound SMS once there are more than a handful of venues.

Ideas, plugins, and pull requests are welcome.
