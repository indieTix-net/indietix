# DailyPgQueryAndSftp

**Last Edited:** 2026-10-28

Nightly scheduled Lambda that generates standardized box-office reports (BDOR/EBOR) for every venue and delivers them over FTP/SFTP to third-party reporting services (Rentrak/comScore-style feeds) — the kind of reporting some distribution contracts require. Node.js.

> **This is the live, production reporting job.** A sibling folder at the workspace root, `eventReporting/`, is an older, confirmed-dead predecessor — not deployed, kept only for reference. All current and future box-office reporting work belongs here.

## What it does, concretely

1. Discovers every client database the same way the other multi-tenant admin Lambdas do (via the shared cluster's `postgres` maintenance database), then reads each client's `Client.configuration`.
2. Resolves the report date: an explicit `event.reportDate` (`YYYY-MM-DD`) if the invoke provides one, otherwise today's date in `America/Chicago`.
3. Skips any client where `USE_FTP` isn't the string `"true"` — this is the real per-venue on/off switch, checked before anything else runs for that client.
4. Calls into SQL functions defined canonically in `clientSetup-Teardown` (`bdor_for_date`, `get_bdor_grouped_for_date`, `get_ebor_engagements_for_date` — this repo's own `src/*.sql` files mirror those definitions for reference, they don't redefine them) to build:
   - A **TDI CSV** (`RTS_<theaterId>_<date>0000.csv`) — the grouped box-office data report
   - An **EBOR XML** (`FRG_<eborTheatreNo>_<date>0000.xml`) — comScore-style engagement report, only generated if `EBOR_THEATRE_NO` is configured
5. Delivers both over FTP/SFTP to up to three configured destinations, with a fixed routing (not freely assignable — this is hardcoded): **FTP1** gets the EBOR XML, **FTP2** and **FTP3** both get the same TDI CSV (two destinations for the same report, e.g. two different recipients who each need their own copy). Each destination's host/port/credentials/type (`ftp` or `sftp`) come straight from `Client.configuration` (`FTP1_HOST`, `FTP1_PORT`, etc.) — editable via the app's Client Settings page.

## Running it manually

```bash
aws lambda invoke \
  --function-name daily-pg-query-and-sftp \
  --cli-binary-format raw-in-base64-out \
  --payload '{"reportDate": "2026-04-26"}' \
  --region your-region \
  result.json
```

Omit `reportDate` entirely to use today (Chicago). An invalid date format returns a `400` before anything else runs.

**Be careful re-invoking this against real client configurations.** FTP destinations configured in production are live, real delivery targets for a nightly job — a manual test run with real client data will actually re-deliver a real report to a real third party, there's no dry-run mode. Test against a sandbox environment's clients (which won't have real FTP credentials configured) rather than production ones, or double-check a given client's `USE_FTP`/`FTP*_HOST` fields are genuinely safe to trigger before invoking against it directly.

## Key files

- `src/index.js` — the handler: client discovery, date resolution, report generation, FTP/SFTP delivery.
- `src/*.sql` — the report-building SQL, mirroring (not redefining) the canonical functions in `clientSetup-Teardown`.
- `dependencies/` — Lambda layer (`pg`, FTP/SFTP clients).
- `bdor/` — sample generated output files for reference (not live data).

## Worth knowing

- `ProductDate` — and therefore every date calculation this job does — is Chicago wall-clock time with no timezone stored in the database. Any change to date logic here needs to account for that, not treat it as UTC.
