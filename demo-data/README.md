# demo-data

A made-up venue, **The Marquee** (a cinema with a live music room in fictional Riverton, KS), for showing IndieTix to people or trying it out: orders, tickets, customers, text opt-ins and sent-text logs, marketing posts, staff logins and box-office report data. By default it has 18 months of history, about 7,600 tickets, 4,400 orders and 2,150 customers, at least as busy as a real single-venue cinema. The size and kind of venue can be changed (below).

Everyone in it is invented. Emails use the reserved `example.com`/`.org`/`.net` domains, phone numbers sit in the 555-0100 to 555-0199 range set aside for fiction, and IP addresses come from the documentation ranges, so nothing can reach a real inbox or phone. Repertory titles are public-domain films; the new releases, live acts and distributors are invented. The tests check all of this.

The data is generated, not copied from any real venue. The same seed and date always give the same venue, and dates are relative to today, so upcoming shows always look upcoming.

## Load it into a test environment

1. Onboard a venue for it in a bootstrap test environment (never production), e.g. `./bootstrap.sh add-client venues/demo.json` with `square_webhook.auto` off.
2. Load (or reset) it:

   ```bash
   cd demo-data && npm install
   DEMO_STAFF_PASSWORD=... DEMO_GUEST_PASSWORD=... ./load-sandbox.sh <client-id>
   ```

## Choosing the size

Every option is optional; add them after the client ID (`./load-sandbox.sh marquee --kind cinema --customers 2000`), or pass them to `node bin/build-sql.mjs`.

| Option | What it sets | Default |
|---|---|---|
| `--kind cinema\|live\|both` | Films only (Main Auditorium and Studio), live events only (The Lounge, more nights), or both | `both` |
| `--months <n>` | Months of history, plus three weeks of upcoming shows | 18 |
| `--tickets-per-movie <n>` | Average tickets sold per cinema showtime | 10 |
| `--tickets-per-live <n>` | Average tickets sold per live event | 14 |
| `--tickets <n>` | Total tickets sold, exactly. Scales the two averages above, keeping their ratio | from the averages |
| `--customers <n>` | How many different people have bought tickets, exactly | orders / 1.9 |
| `--orders-per-customer <n>` | Average orders per customer | 1.9 |
| `--seed <n>` | A different (but repeatable) venue | fixed |

The numbers fit together as tickets = showtimes x tickets per show, and orders = customers x orders per customer, so each order's size follows from those (one order needs at least one ticket; asking for more orders than tickets is refused with a message). Busy weekends, popular films, the odd sell-out and regulars who buy most of the tickets are kept whatever the size. Upcoming shows only have presales, and averages are over shows that have already happened.

"Customers" are the people who bought tickets. About 45% of them left a phone number, and those are the rows in the `Customer` table (the one IndieTix keys on phone numbers).

Loading wipes that venue's orders, tickets, customers, staff logins and marketing posts and rebuilds them, so run it again to undo anything visitors changed. It refuses an environment whose `bootstrap.config.sh` sets `ENV_IS_PRODUCTION="true"`.

## Test and performance data

The same generator seeds tests and load tests. To load straight into any Postgres instead of a test environment (no Lambda in between), start a throwaway local venue database (Docker) and point the generator at it:

```bash
node bin/local-venue.mjs                      # prints a postgres:// URL; Ctrl+C removes it
node bin/build-sql.mjs --client demo --database-url <that url> --tickets-per-live 1000 --tickets-per-movie 20
```

`--database-url` works with any database that already has the venue schema and its `Client` row (onboarding, or `local-venue.mjs`, creates both). On a laptop, 1,000 tickets per live event and 20 per film over 18 months (about 161,000 tickets, 92,000 orders and 45,000 customers) generates in about 2 seconds and loads in about 15, peaking near 1.4 GB of memory. The whole venue is built in memory first, so a few hundred thousand tickets per run is the practical ceiling; for more, run node with a larger heap (`node --max-old-space-size=8192 bin/build-sql.mjs ...`). `--tickets` accepts up to 1,000,000.

## Logins

| Login | Can do |
|---|---|
| `guest` | See everything (orders, tickets, reports) and scan tickets; can't change settings, staff, marketing or use Insights |
| `guest-door` | Door scanning only |
| `manager`, `boxoffice`, `door` | Staff examples with different permission levels |

Log in with the venue's client ID plus one of these usernames. The venue's own login (client ID and its secret) has full access.

The demo isn't connected to Square, so pages that talk to Square (adding a movie or event, refunds, marketing item lists) show an error rather than changing anything.
