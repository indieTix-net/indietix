# IndieTix

A Square-integrated ticketing platform for independent venues... built to run your own box office without handing a cut of every ticket to a company that had nothing to do with the show.

## Why IndieTix Exists

Most ticketing platforms take too much of a cut.  Fees from the ticket giants hang in the range of 20% - 30% or more of what the actual base ticket price is. That most of those fees don't go to the people who made the night happen. The artists, musicians, promoters, or venue: very little of the cut goes to them. It goes to a ticketing company that didn't write a note, book a stage, or sweep a floor, but still gets paid like it did. 

IndieTix exists to cut that middleman out.

IndieTix was built as tool for one independent event space and cinema trying to run its own box office without handing a slice of every ticket to a company that had nothing to do with the film, the venue, or the night itself. It's grown into a full ticketing platform, but the principle hasn't changed: The people putting on the show, the venues, the promoters, the artists, should be the ones deciding what a ticket costs, not a platform with no stake in whether the show is any good. Fees should fund the event, not a stranger's margin.

IndieTix is free, open source, and yours to self-host and modify with no strings attached... no tier that unlocks "real" control, no cut of your ticket sales baked into the code. If you'd rather not run the infrastructure yourself or need help, hosted and supported plans are available too. 

## Free or hosted: same software either way

| | Self-hosted | Hosted by IndieTix |
|---|---|---|
| Software | Free (AGPL) | Included |
| Features | Everything | Everything |
| Who runs it | You, on your own AWS account | We do |
| Running costs | Your AWS bill | A flat monthly plan, see [indietix.net](https://indietix.net) |
| Fees on ticket buyers | None | None |
| Updates and backups | You apply them | We handle them |
| Support | Email support@indietix.net, best effort, no SLA | Email support@indietix.net, best effort, no SLA |
| Support plans | Available, see [indietix.net](https://indietix.net) | Available, see [indietix.net](https://indietix.net) |
| Texting | Your own carrier-approved campaign and texting costs | Same: each venue has its own campaign and pays its own texting costs |

There is no paid tier that unlocks features. The hosted plan is for venues that would rather not run servers.

**About email support:** anyone can write to support@indietix.net and we'll do our best to help, but without a support plan there's no guarantee of a response or of how long one takes. Support plans with defined terms are sold on [indietix.net](https://indietix.net).

## Running in production

IndieTix has run Liberty Hall in Lawrence, Kansas, since April 2025: 6,700+ tickets and $79,000+ in sales across 575 showtimes and events, with no fees charged to buyers. [Read the case study](./docs/case-study-liberty-hall.md).

## What it does

Square handles payment and catalog; IndieTix handles everything around the sale — QR-coded PDF tickets delivered by email and (opt-in) SMS, door check-in via a web scanner, box-office reporting, event and cinema creation and scheduling, a marketing scheduler that posts to email, Facebook and Instagram (TikTok is waiting on TikTok's approval), self-serve signup with Square sign-in, and an admin console for managing it all. Each venue (client) is fully isolated: its own database, its own S3 buckets, its own Square credentials, its own SMS campaign — share-nothing multi-tenancy, not a shared pool with row-level permissions.

For the full tour of what the platform actually does day to day, see [`infrastructure/FUNCTIONALITY.md`](./infrastructure/FUNCTIONALITY.md).

## Built to pass a security review

IndieTix is small enough for a single-screen cinema and built to the standard a university, city or arts center's security review expects. In place today:

- **Venues are fully isolated.** Each venue gets its own database and database login, its own storage, its own secrets and its own SMS campaign.
- **Card data never touches IndieTix.** Square takes the payment, so almost all of PCI's card-security scope stays with Square.
- **Encrypted** at rest (the database and file storage) and in transit (HTTPS everywhere).
- **A firewall in front of the API**: AWS WAF with rate limits on logins, signup, password resets and public pages, plus AWS's managed rule sets for known attacks and bad addresses. Square webhooks are checked against Square's signature.
- **Threat detection and an audit trail.** GuardDuty watches the AWS account and emails medium and high findings. CloudTrail records every account action, kept a year, with tamper-evident log validation.
- **Least-privilege access, enforced on the server.** Five permission flags, new staff accounts start at check-in only, per-promoter data filters, scoped API keys stored only as hashes, and refunds, cancels and deletes record who did them.
- **Privacy requests built in.** A venue can find, export or erase one customer's personal details (GDPR and CCPA-style requests). Erasing replaces the details rather than deleting the records, so sales and box-office reports stay correct, consent records are kept as legal proof, and every request is logged without storing the person's email or phone.
- **SMS done by the book.** A 10DLC campaign per venue, consent captured word for word with its audit details, STOP honored per venue, and spending caps on outgoing texts.
- **Monitoring and a status page.** Alarms email when orders, the webhook, the operator app or a background job starts failing, and again when it recovers. A public status page shows each part as working or not.
- **Backups that have actually been restored.** Point-in-time restore, tested by restoring a live database into a separate copy and matching every table.
- **Logs that don't pile up.** Kept 30 days by default.
- **Controlled changes.** Every change goes through a pull request with about 730 automated tests against real Postgres. Production deploys show a diff and save a revert copy first.

IndieTix isn't SOC 2 audited yet. The controls above are built with it in mind, and a formal audit will follow when a customer needs one. Setup details for each piece are in [`infrastructure/README.md`](./infrastructure/README.md#security-and-privacy).

## What's in this repo

Each folder below is one piece of the platform, with its own README and tests. Start with `infrastructure` if you're standing up your own deployment.

| Folder | What it is |
|---|---|
| [`infrastructure`](./infrastructure) | SAM templates, `deploy.sh`/`bootstrap.sh`, and the full setup/deploy walkthrough. **Start here.** |
| [`square-queue-forwarder`](./square-queue-forwarder) | Square webhook receiver — hands off to SQS and returns fast |
| [`getSquareOrders`](./getSquareOrders) | Consumes the queue, generates QR-coded PDF tickets, sends confirmation email/SMS |
| [`QRScanner`](./QRScanner) | The operator app: door check-in, orders/products/reports, client settings, marketing scheduler |
| [`clientSetup-Teardown`](./clientSetup-Teardown) | Onboards/offboards venues — the canonical source of truth for the database schema |
| [`clientReporting`](./clientReporting) | Small reporting Lambda over client data |
| [`smsOptInOptOut`](./smsOptInOptOut) | Keeps SMS consent in sync with two-way texting (STOP/START) |
| [`expireQRCodeSquareModifiers`](./expireQRCodeSquareModifiers) | Expires past showtimes in Square's catalog |
| [`DailyPgQueryAndSftp`](./DailyPgQueryAndSftp) | Nightly box-office report generation and delivery (BDOR/EBOR) |
| [`marketingEngine`](./marketingEngine) | Turns schedules into marketing post drafts; sends approved posts across channels |
| [`squareTokenRefresher`](./squareTokenRefresher) | Daily renewal of Connect Square (OAuth) venues' Square access |
| [`printer`](./printer) | Optional local agent for printing physical ticket stubs on a LAN label printer |
| [`sms-utils`](./sms-utils) | Shared phone normalization + SMS-sending Lambda layer |
| [`ticket-pdf-lib`](./ticket-pdf-lib) | Shared QR-code + ticket-PDF rendering Lambda layer |
| [`test-db-harness`](./test-db-harness) | Disposable local Postgres containers for the test suites |

## Setup & Deploy

See [`infrastructure/README.md`](./infrastructure/README.md) for the full walkthrough — AWS setup, connecting Square, Google Calendar, social media, and ticket printing. [`infrastructure/DEPLOY.md`](./infrastructure/DEPLOY.md) documents the deploy tooling itself.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Contributors sign a one-time [Contributor License Agreement](./CLA.md). Found a security problem? Please report it privately; see [`SECURITY.md`](./SECURITY.md).

## License

AGPL-3.0-or-later — see [`LICENSE`](./LICENSE). Chosen deliberately: IndieTix's model is free self-hosted code plus optional paid hosting/support, and AGPL keeps a hosted competitor honest about sharing improvements back, the way a permissive license wouldn't.

**Self-hosting comes with no warranty or service commitment.** If you run IndieTix yourself, it's provided as is, as the license says: no guarantee of uptime or availability, that it's error-free, or that it fits your purpose, and no support commitment (best-effort email help aside, as above). Running, securing, backing up and updating your copy is up to you. The hosted service's commitments are in its [Terms of Service](./QRScanner/src/public/indietix-terms.html), which don't apply to self-hosted copies.
