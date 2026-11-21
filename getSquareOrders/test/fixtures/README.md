# Recorded real orders (characterization fixtures)

**Last Edited:** 2026-11-20

`liberty-hall/*.json` are real Liberty Hall sales, replayed by `test/recordedOrders.test.mjs`. Each one holds what Square sent and answered for that sale, and the rows production's getSquareOrders wrote for it. The test feeds the recording through the handler and requires the same `Order` row, the same `QRCodeProduct` rows (name, showtime, room, ticket type, price, distributor, event type, customer fields, stored line-item metadata), one email with one PDF per ticket, and no change when the webhook arrives again.

They exist so that the native-events work and the POS split (see `NATIVE_EVENTS_PLAN.md` / `POS_INTEGRATIONS_PLAN.md`) can't change what a real sale produces without a test saying so. If a change is *meant* to alter the output (e.g. stamping a `ShowingID`), update the expected values in the fixture on purpose and say why in the commit.

## Where they came from

- **Recorded** (13): production's getSquareOrders CloudWatch logs (30-day retention), 2026-10-29 to 2026-11-20. The logs hold the webhook and Square's full payment, customer, order and catalog responses. Distributor/event-type names come from the logged selection lookups. Expected rows are what production wrote to its database. 10 of the 13 ran on the code deployed 2026-11-01; `online-*` and `register-other-tender-mixed` ran on the Oct 26 code a few hours before it. The monorepo code reproduced all of them unchanged on 2026-11-20.
- **Rebuilt** (2, the discounts): older than the log window. The order is the real one Square sent (production's `Order.OrderMetaData`); the catalog is rebuilt from each ticket's stored line item (`QRCodeProduct.ProductMetadata`, which keeps the custom-attribute IDs); payment is the minimum the code reads. Added because none of the recent sales had a discounted ticket, so a price-calculation change went unnoticed without them.

## Personal data

None. Names, emails, phones, addresses, card details (last 4, BIN, fingerprint, network reference), Cash App handle, receipt links, notes, open-ticket names, and Square customer/staff/device IDs are replaced by consistent fakes (`buyer01@example.com`, `Given01`, `+15555550011`, `redacted-07`, `FIXTURECUSTOMER01`, ...). The venue's owner email and walk-up phone are `owner@example.com` and `+15555550100`. Liberty Hall's merchant ID is `LHFIXTUREMERCHANT`. Kept as-is: Square order/payment/catalog IDs, item names, prices, showtimes, rooms, and public item descriptions. The generator refused to write if any original personal value remained anywhere in the output. Don't hand-add real customer data when adding a fixture.

## The shapes

| Fixture | What it covers |
|---|---|
| `register-card-single` | Box office register, card, 1 ticket (the most common sale) |
| `register-card-multi-qty` | Register, card, quantity 2 on one line |
| `register-card-multi-line-tickets` | Register, card, Adult + Senior lines in one order |
| `register-cash-single` | Cash walk-up: no buyer details, so owner email + walk-up phone are used |
| `register-gift-card` | Register, Square gift card |
| `register-free-comp` | Register, $0 open-price ticket |
| `register-comp-100pct-discount` | Register, qty 2 with a 100% line-item discount (rebuilt) |
| `register-other-tender-mixed` | Register, "other" tender, tickets + taxed merchandise |
| `pos-mixed-concessions` | Point of Sale app: live-event tickets + concessions (Spacement room) |
| `pos-half-price-discount` | Point of Sale app, qty 3 with a 50% order-level discount (rebuilt) |
| `online-card-single-no-svc` | Square Online, card, 1 ticket |
| `online-card-svc-multi-qty` | Square Online, qty 3, online service charge |
| `online-multi-line` | Square Online, Adult + Senior lines |
| `online-wallet` | Square Online, wallet payment |
| `concessions-only` | No ticketed items: no Order row, no email |

Rooms covered: Main Auditorium, Little Theater, Spacement. Event types: Movie, Live. Every Liberty Hall ticket line has exactly one showtime modifier.

**Not covered** (never seen in Liberty Hall's 4,233 orders as of 2026-11-20): refunds or returns inside an order (refunds go through QRScanner), more than one modifier on a ticket line, line items without a catalog item. `ONE_PER_EMAIL_ITEMS` and SMS auto-send have their own tests.

## Adding one

Record from production read-only, anonymize, and check the result for personal data before committing. The scripts used on 2026-11-20 (log extraction, rebuild, anonymizer with the leak check) weren't committed, since they hold production access details; ask Claude to recreate them.
