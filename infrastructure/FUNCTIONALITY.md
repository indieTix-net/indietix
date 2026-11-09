# What IndieTix Does

**Last Edited:** 2026-11-06

A high-level tour of what the platform actually lets a venue do, grouped the way the app itself groups it (by who's allowed to do what). For setup and integration details, see [README.md](./README.md). For the full step-by-step on bringing up a brand-new venue, see [CLIENT_SETUP.md](./CLIENT_SETUP.md).

**Running a venue day to day?** The step-by-step guide for venue staff (with screenshots) is in [`support/knowledge/`](../support/knowledge/), published as the Help pages at `/help/` on every venue's site.

## Selling tickets

Tickets are sold through Square — IndieTix doesn't run its own checkout. When a customer completes a Square order for a ticketed item, IndieTix automatically:
- Generates QR-coded PDF tickets, one per ticket purchased
- Emails them to the customer, with an SMS opt-in offer if texting is enabled for the venue
- Texts the ticket directly if the customer has already opted in

## At the door

- **Ticket Scanner** — the default landing page. Scans via the device camera (no file-upload option) — uses the browser's native `BarcodeDetector` when available for faster decoding, and auto-prefers a rear/environment-facing camera on phones and most USB webcams. Two per-session toggles let staff tune the experience: **Auto Check-in** (check a valid ticket in the moment it's scanned, no extra tap) and **Sound** (an audible success/error tone on each scan, useful when staff aren't staring at the screen). A 2-second cooldown on the same QR value prevents a shaky hand from double-firing one scan; the reader border flashes red during that cooldown. Scanning an already-checked-in ticket shows a non-alarming "already checked in" notice rather than a hard error. In non-auto-checkin mode, a successful scan pauses (camera stays live) and shows confirm/deny buttons instead of committing immediately.
- **Manual Checkin / List Tickets** — look up and check in a ticket by hand when a camera scan isn't practical (no QR code handy, a phone screen that won't scan, a comp ticket). This is also where a USB/Bluetooth handheld barcode scanner is used in practice — there's no dedicated scanner-input handling anywhere in the app, but most handheld scanners emulate a keyboard, so one just types into whatever search field has focus here.
- **Today's Dashboard** — a live view of the day's showtimes and check-in activity, built for staff running the door.
- **Skeleton Keys** — multi-use QR codes for staff bypass (comp tickets, re-entry passes, testing), managed from Client Settings' "Skeleton Keys" section, not a separate page. Each key has a type (Comp / Re-entry / Staff / Other), a description, and optional limits: max uses per day, max total uses (lifetime), and an expiration date — leave any of those blank for no limit. A key can be deactivated without deleting it, which preserves its usage history. At check-in, a scanned code that isn't a real ticket is checked against the skeleton key table; beyond whatever limits you configure, there's one hardcoded anti-abuse floor that always applies regardless of settings: **no more than 5 uses of the same key in any rolling 10-minute window**. Every use is logged (event name, notes, IP address) for later review.

## Managing orders

- **List Orders** — search and review every order: customer info, tickets purchased, payment status.
- Refund an order, cancel an order, or resend a confirmation email, right from the order view — no need to go into Square to handle a customer issue.
- **Editing an order** is limited to the buyer's contact info (name, phone, email) — there's no price/showtime/seat editing through IndieTix; once a Square item is live, those changes happen in the Square dashboard directly. Editing an order's contact info also propagates to the tickets linked to that order (capped at the first 10 tickets on a single order — a rare edge case, but worth knowing if a venue ever sells a block that large to one buyer).
- **Transfer Tickets** — move a valid, not-yet-checked-in ticket to a new person by name, email, and optional phone. The original ticket is permanently voided (can never be checked in again, and box-office reports don't double-count it) and a brand-new ticket — new QR code, same event/price/seat details, same underlying order for revenue reporting — is generated and emailed to the new recipient. Deliberately email-only, no SMS: the new recipient hasn't gone through SMS consent, and transfer isn't meant to be a backdoor around that. If the email fails to send, the transfer still completes (the ticket is real either way) and staff get the new QR code to resend by hand.
- **Print Ticket** (optional, see the README's printing section) — from the Products page's action menu, send a ticket straight to a physical label printer at the venue, for a venue that wants to hand customers a real paper stub instead of (or alongside) the emailed/texted PDF.
- **Print Tickets** (whole order) — from the Orders page's action menu, print every valid ticket on an order in one click, in order, with no popup. Refunded, cancelled and transferred tickets are skipped. The print agent prepares the next ticket while the current one prints.
- **Confirm Check-in & Print** — in the check-in confirm box, check the person in and print their stub in one tap. It only prints after a successful check-in, and a print failure leaves them checked in and says so.

## Adding movies and events

- **Movie Info Lookup** and **Event Info Entry** — the two pages for putting something on sale. An OMDB lookup (for movies) pre-fills title/year/rating/runtime/genre/director/cast/plot, which staff can edit before creating — that's the only "editing" available here; there's no way to modify a Square item's price or showtime after it's created through IndieTix, only in Square directly. On create, IndieTix builds the Square catalog item for you — the ticketed-item flag, distributor/event-type attributes, and showtime modifiers are all set up automatically. No need to hand-build any of that directly in Square.
- Optionally push each showtime straight to Google Calendar at the same time (see the README's Google Calendar setup section). If Google Calendar isn't set up in Client Settings, the checkbox is unchecked and greyed out, and the result message always says whether calendar events were actually created.
- Movie Info Lookup warns as soon as it opens if no OMDB API key is set in Client Settings, and disables search until one is.
- Past showtimes are expired and fully-run items are archived automatically — no manual cleanup.

## Reporting

- **Event Report** — a report for a single showtime or event: tickets sold, revenue, check-in status. The one place in the app with data export: **Export to Excel** and **Export to CSV** buttons dump whatever's currently in the report table (QR code, event, date, customer, contact info, distributor, event type, venue, seat, price, status, purchase date) to a file. No export exists on Orders, Insights, or the Dashboard — just this page.
- **Insights** — venue-wide business analytics (admin-only). Ask a question in plain English ("how many tickets did we sell last weekend," "what's our top-selling movie this month") and an AI layer turns it into a real database query, runs it, and hands back a readable answer — no SQL or report-building required.
- **Box office reporting (BDOR/EBOR)** — a nightly automated job generates standardized box-office reports and delivers them via SFTP/FTP to third-party reporting services (e.g. comScore), if a venue's contracts require it. Runs on its own; nothing to do day-to-day once it's configured.

## Marketing (the "Marquee Engine")

- **Marketing Schedule** — set up a posting schedule for a movie or event (e.g. an announcement post, a reminder a few days before, one on opening day) across email, Facebook, Instagram, and TikTok.
- A weekly digest option, instead of per-item posts: one roundup of everything playing that week.
- Drafts are generated automatically on schedule; a human reviews and approves each post before anything goes out — approval is the one checkpoint across every channel. Once approved, posts send automatically at their scheduled time (email can also be sent immediately as a manual override).
- Captions can be hand-written, template-generated, or AI-generated, your choice per schedule.
- **Email List** — manage the list of subscribers who receive marketing emails, separately from ticket buyers' transactional emails.

## Getting started (hosted)

- **Self-serve signup.** A venue fills in its name and contact details, signs in with Square, and has a working box office about a minute later. A welcome email sets the password.
- **Connect Square in one click.** No developer account or pasted tokens. Access renews itself, and if a venue disconnects IndieTix in Square, it's told how to reconnect.
- **A support page** with the support address and answers to common questions.

## Accounts and access

- **User Management** (client login only) — add staff accounts and control what each one can do. Five permission flags: `view`, `edit`, `checkIn`, `marketing`, `admin`. A new account gets `checkIn` only, so it's least privilege unless you grant more. There are two kinds of login: the venue's own **client** login (the original master account, which can do everything) and **sub-user** logins, which can only do what their flags allow. The flags are independent of each other; `admin` is not a "grant everything" flag. What each flag unlocks:
  - `view`, `edit` or `checkIn` (any one) → Ticket Scanner, Manual Checkin, Today's Dashboard, and per-ticket refunds and transfers
  - `view` or `edit` → List Orders, Event Report, and order edits, refunds and email resends
  - `edit` → Movie/Event creation (including poster uploads)
  - `marketing` → Marketing Schedule, Email List
  - `admin` → Insights
  - **Client login only, no flag unlocks them:** Client Settings, User Management, Skeleton Keys, and API Keys
- **Permissions are enforced by the server.** Every API route checks the caller's flags itself, not just the menu in the browser. A sub-user who calls an endpoint directly gets the same "no" the UI would have shown them. Two details worth knowing: permission changes take effect at the user's next login (a login token lasts up to 24 hours), and refunds, cancels and deletes record which user did them, so you can audit them later.
- **Data filtering for a 3rd party** — each sub-user can have one or more filters (configured on the User Management page: an "Add Filter" row with a date, an event dropdown, an "event name contains" box, and an event type of Cinema or Live) that get written into a `DataFilter` field on their account. Multiple filters are OR'd together; the fields within one filter are AND'd. The event dropdown lists every ticketed item in the venue's Square catalog plus every event that has already sold tickets, so a promoter's account can be set up before their show's first sale. Picking an event from the dropdown matches that exact name; "event name contains" matches any part of it ("Rocky" covers both "Rocky Horror" and "The Rocky Horror Picture Show"). Capitals never matter. The server folds the filter into every relevant query (ticket lists, orders, the dashboard, and single-ticket and single-order lookups and edits), so a filtered sub-user genuinely only ever sees the tickets and events matching their filter. Anything outside it answers exactly like "not found". It's a real way to give a promoter, distributor, or co-presenter visibility into just their own numbers without seeing the rest of the venue's business. One honest tradeoff: a showtime with zero sales so far won't show up for a filtered user on the dashboard, since filtering happens against the ticket table, not the full Square catalog.
- **Client Settings** (client login only) — the control panel for a venue's entire configuration: Square credentials, branding, Google Calendar and social media integrations, SMS settings, FTP reporting destinations, Skeleton Keys, API Keys, and more.

## Privacy requests

- **Privacy Requests** (client login only, linked from Client Settings) — for when a customer asks what the venue holds about them, or asks to be erased (GDPR, CCPA and similar laws). Search by email or phone to see their orders, tickets, customer record, text-message consent and email-list entries.
- **Download Their Data** exports everything about them as a JSON file to send back.
- **Erase Their Details** replaces their name, email and phone on every order, ticket, customer record, text log and email-list entry, and scrubs personal fields from Square's stored order details. The records themselves stay, so sales, refunds and box-office reports remain correct, and their tickets keep working. Text-message consent records are kept as legal proof of consent, and any active consent is revoked so no more texts go out.
- **Request log** — every download and erasure is recorded with when it came in, how the venue confirmed it was really the person, what was found and who did it. The log never stores the person's email or phone, only a one-way fingerprint.

## Public API

A small, documented REST API (`/v1`) lets the tools around a venue work with its IndieTix data: a third-party door scanner, a promoter's dashboard, the venue's website, a spreadsheet. It's free and part of the self-hosted app, with no paid tier. It's read-mostly. Checking a ticket in (and undoing that) is the only write; selling, pricing and refunds stay in Square.

- **Endpoints:** showtimes; tickets (list, or one by QR code); orders (list, or one with its tickets); check-in and undo check-in; and a sales and attendance report by showtime or by event.
- **API keys** are created from **Client Settings → API Keys** with the client login. A key is shown once when it's created. Only a SHA-256 hash of it is stored, and it can be revoked at any time. Each key carries only the **scopes** you give it: `showtimes:read`, `tickets:read`, `orders:read`, `orders:pii`, `reports:read`, `checkin:write`. Buyer name, email and phone are a separate scope (`orders:pii`), so a promoter's dashboard can see sales without seeing customers.
- **A key can carry data filters**, with the same date / event / name-contains / event-type editor sub-users have, so a key handed to one promoter only ever sees, and can only check in, that promoter's tickets. Unlike a sub-user's filter, a change to a key takes effect immediately.
- **Guard rails:** 120 requests per minute per key (HTTP 429 with `Retry-After`), an `Idempotency-Key` header so a retried check-in is never applied twice, and check-in refuses refunded, cancelled, deleted and transferred tickets. API keys can't use Skeleton Keys.
- **Conventions:** JSON in and out, `{ "data": ... }` on success and `{ "error": { "code", "message" } }` on failure, cursor pagination, and ISO 8601 times (showtimes carry the venue's UTC offset). `/v1` only ever changes additively; anything breaking becomes `/v2`.
- **Docs:** the full reference is an OpenAPI 3.1 spec (`QRScanner/src/public/openapi.yaml`), rendered at `/api-docs.html` on the venue's static site.

## Customer-facing pages

- **SMS opt-in** — the page a customer lands on after choosing to get their ticket by text instead of email.
- **Unsubscribe / email list signup** — standard list-management pages for marketing email, separate from the transactional ticket emails every buyer gets regardless.
- **Status page** (`status.html`) — shows customers and staff whether each part of IndieTix (ticket sales, the box office pages and door scanning, text messages, nightly reports and so on) is working, driven by the same alarms that email the operator. It never shows alarm names or details.
- **The venue's own web address** — each venue can pick `<name>.<domain>` (for example `yourvenue.indietix.net`) in Client Settings or at signup. Its login page fills in the venue's Client ID, and its privacy and terms pages show that venue's own details.

## Works on mobile

Beyond ordinary responsive CSS (real `@media` breakpoints across every major page), there's a dedicated mobile hamburger menu, and the Ticket Scanner page's camera handling (described above) is specifically built with phone/tablet use at the door in mind, not just "happens to work" on a small screen.
