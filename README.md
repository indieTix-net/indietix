# IndieTix

A Square-integrated ticketing platform for independent venues... built to run your own box office without handing a cut of every ticket to a company that had nothing to do with the show.

## Why IndieTix Exists

I think some most ticketing platforms take too much of a cut.  Lately, I've seen fees from the ticket giants hang in the range of 20% - 30% or more of what the actual base ticket price is. That most of those fees don't go to the people who made the night happen. The artists, musicians, promoters, or venue: very little of the cut goes to them. It goes to a ticketing company that didn't write a note, book a stage, or sweep a floor, but still gets paid like it did.

IndieTix exists to cut that middleman out.

IndieTix was built as tool for one independent event space and cinema trying to run its own box office without handing a slice of every ticket to a company that had nothing to do with the film, the venue, or the night itself. It's grown into a full ticketing platform, but the principle hasn't changed: **the people putting on the show — the venues, the promoters, the artists — should be the ones deciding what a ticket costs**, not a platform with no stake in whether the show is any good. Fees should fund the event, not a stranger's margin.

IndieTix is free, open source, and yours to self-host and modify with no strings attached — no tier that unlocks "real" control, no cut of your ticket sales baked into the code. If you'd rather not run the infrastructure yourself or need help, hosted and supported plans are available too. 

## What it does

Square handles payment and catalog; IndieTix handles everything around the sale — QR-coded PDF tickets delivered by email and (opt-in) SMS, door check-in via a web scanner, box-office reporting, event and cinema creation and scheduling, a marketing scheduler that posts to email/Facebook/Instagram/TikTok, and an admin console for managing it all. Each venue (client) is fully isolated: its own database, its own S3 buckets, its own Square credentials, its own SMS campaign — share-nothing multi-tenancy, not a shared pool with row-level permissions.

For the full tour of what the platform actually does day to day, see [`infrastructure/FUNCTIONALITY.md`](./infrastructure/FUNCTIONALITY.md).

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

## License

AGPL-3.0-or-later — see [`LICENSE`](./LICENSE). Chosen deliberately: IndieTix's model is free self-hosted code plus optional paid hosting/support, and AGPL keeps a hosted competitor honest about sharing improvements back, the way a permissive license wouldn't.
