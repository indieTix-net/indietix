# The IndieTix guide (and support knowledge pack)

These pages are the one source for two things:

- **The help pages** at `/help/` on every venue's site (and the GitHub view of this folder). `help/build.mjs` turns each file into a page when the static site is deployed; screenshots are in `images/`, taken from the demo venue by `help/screenshots.mjs`.
- **The support inbox's knowledge.** Every page here (not this README, not the images) is sent, as written, to the model that drafts replies to email sent to support@indietix.net. A person reviews and edits every draft before it's sent; nothing is sent automatically.

Keep it to what a venue or ticket buyer could be told. Never add internal notes, account IDs, production details, credentials, prices, or anything about a specific venue. Pricing points to https://indietix.net.

Pages appear in file-name order. Each starts with one `#` title; `##` headings become its sections. Link between pages with their file names (`[At the door](05-at-the-door.md)`), and to a section with its heading (`05-at-the-door.md#todays-dashboard`). Images: `![What it shows](images/name.webp)`, taken by the screenshot script (add new ones to its list).

| File | Covers |
|---|---|
| `01-what-indietix-does.md` | What IndieTix is, a night at the box office start to finish, the menu |
| `02-getting-started.md` | Signing up, logging in, the first settings to fill in |
| `03-selling-tickets.md` | Connect Square, where tickets sell, pickup only, what the buyer gets |
| `04-adding-movies-and-events.md` | Add a movie or event step by step, ticket types, and how a ticket item is built in Square |
| `05-at-the-door.md` | Scanning, manual check-in, Today's Dashboard, skeleton keys, printing |
| `06-orders-refunds-and-resends.md` | Resend, edit, refund, cancel, transfer, print an order |
| `07-reports-and-insights.md` | Event Report, Insights, nightly distributor reports |
| `08-marketing-and-texting.md` | Marketing posts, the email list, text-message tickets and 10DLC |
| `09-staff-and-permissions.md` | Staff accounts, what each permission allows, data filters |
| `10-settings-and-your-web-address.md` | Every Client Settings section, logo, web address, API keys |
| `11-privacy-account-and-status.md` | Privacy requests, closing an account, the status page, security reports |
| `12-troubleshooting.md` | Common problems and fixes |
| `13-for-ticket-buyers.md` | Answers for people who bought a ticket |

Not covered on purpose, so drafts say a person will follow up: pricing and billing, refunds of IndieTix fees, contracts and legal terms, anything about a specific venue's data, and security reports (those go to SECURITY.md's process).
