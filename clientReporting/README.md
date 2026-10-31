# clientReporting

**Last Edited:** 2026-10-28

Small read-only Lambda that consolidates `Client` records across every venue's database into one response — a cross-tenant view that nothing else in the platform has, since every other Lambda is scoped to one client database at a time. Not part of the request-serving path for ticketing or check-in; this is an operational/admin tool. Node.js, CommonJS. Shares a Lambda layer with `clientSetup-Teardown`.

## What it does

1. Connects to the shared Aurora cluster's `postgres` maintenance database to discover every client database (excludes `postgres`, `template0`, `template1`, `rdsadmin`, and `indietix` itself).
2. Connects to each one in turn (with a small delay between connections to avoid hammering the cluster) and reads every row from its `Client` table, if that table exists — a database without one is skipped rather than treated as an error.
3. Consolidates all of it into one response, tagged with which database each record came from.

## Invoking it

```bash
aws lambda invoke \
  --function-name client-reporting \
  --region your-region \
  result.json
```

Supports optional query-string-style filters passed via `event.queryStringParameters` (this Lambda is written to also work behind an API Gateway/Function URL, not just a raw invoke):

| Param | Effect |
|---|---|
| `database_filter` | Only include clients whose source database name contains this substring |
| `status_filter` | Only include clients whose `Status` matches exactly (case-insensitive) |
| `include_configuration` | `'true'` to include each client's full `configuration` JSON in the response. **Defaults to `'false'`.** |

`clientSecret` is always stripped from every response regardless of `include_configuration` — that field never leaves this Lambda.

**Worth knowing:** `include_configuration` used to default the other way — any value other than the literal string `'false'` leaked every client's full configuration (Square access tokens, signature keys, SMS campaign IDs, everything) by default. Fixed 2026-10-25, found while writing this repo's test suite. If you're calling this Lambda from somewhere that predates that fix, double check it isn't relying on the old inverted default.

## Response shape

```json
{
  "summary": {
    "total_clients": 3,
    "filtered_clients": 1,
    "databases_scanned": 3,
    "clients_per_database": { "venuea": 1, "venueb": 1, "venuec": 1 }
  },
  "clients": [ /* filtered Client rows, keys lowercased */ ],
  "timestamp": "..."
}
```

## Key files

- `src/index.js` — the whole function: database discovery, per-database querying, filtering, and the response shape above.
