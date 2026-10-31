# expireQRCodeSquareModifiers

**Last Edited:** 2026-10-28

Scheduled Lambda that keeps a venue's Square catalog clean: removes showtime modifiers for showtimes that have already happened, and archives Square items whose entire run has completed. Node 22, ESM.

## What it does, concretely

Runs on a schedule (an EventBridge rule — check your deployment's actual cron expression rather than assuming one here). On each run:

1. Connects to the shared Aurora cluster's `postgres` maintenance database (a system catalog every cluster has, not any one client's own database) to discover every client database that exists — this is how it finds "every venue," without a separate routing table.
2. For each client, reads its `Client.configuration` from Secrets Manager / its own database and skips it entirely if `SQUARE_ACCESS_TOKEN` is missing.
3. Fetches Square catalog items in that venue's configured categories (`TARGET_CATEGORIES`, comma-separated, default `Cinema,Events`) with the ticketed-item attribute set (`USE_QR_CODE` attribute name, default `UseQRCode`; `USE_QR_CODE_VALUE`, default `"true"`).
4. For each item, inspects its showtime modifiers (filtered by name via `MODIFIER_NAME_FILTER`, default `"Show Times"`) and parses the date/time embedded in each modifier's name (`MM-DD-YYYY H:MM AM/PM`, assumed Chicago time — the same format IndieTix's own Add Movie/Add Event flow generates). A modifier is considered expired once its showtime is more than **5 hours** in the past, not the instant it passes — a deliberate grace window.
5. Removes expired modifiers from the item. If an item has no modifiers left after that (its entire run is done), archives the Square item itself via the Catalog API, rather than deleting it — archived items stop showing up for ticket sales but the historical catalog object (and its order history) stays intact.

## Why archiving, not deleting

Square's Catalog Search API still returns archived items by default (`item_data.is_archived === true` on the object) — archiving isn't the same as hiding from every query. `filterItemsByCustomAttribute()` explicitly skips already-archived items when picking candidates for further processing, so a venue's catalog doesn't accumulate repeat-processing of the same already-done items. (The exact same class of bug — forgetting to filter out archived items — has shown up independently in QRScanner's own marketing item search; if you're touching either, worth checking the other.)

## Config fields this Lambda reads

All live in `Client.configuration`, defined canonically in `clientSetup-Teardown` — don't add a new field here without adding it there too:

| Field | Default | Purpose |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | — (required; client skipped if missing) | Square API auth for this venue |
| `USE_QR_CODE` | `UseQRCode` | Custom attribute name flagging ticketed items |
| `USE_QR_CODE_VALUE` | `"true"` | Value that attribute must equal |
| `MODIFIER_NAME_FILTER` | `Show Times` | Which modifier list to treat as showtimes |
| `TARGET_CATEGORIES` | `Cinema,Events` | Comma-separated Square category names to scan |

## Key files

- `src/index.mjs` — the whole thing: client discovery, Square Catalog API calls (search/retrieve/update/archive), date parsing, and the per-client orchestration loop.
- `src/nodejs/` — Lambda layer.
