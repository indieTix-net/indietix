# clientSetup-Teardown

**Last Edited:** 2026-10-28

The one Lambda that creates and destroys a venue end to end: PostgreSQL user, database, full schema, a Secrets Manager entry, S3 buckets (with ticket templates pre-loaded), and the `Client` configuration row. Tear-down reverses all of it. Node 22, CommonJS.

For the full platform-level walkthrough (including how this fits into standing up a brand-new environment), see [infrastructure/CLIENT_SETUP.md](../infrastructure/CLIENT_SETUP.md). This README covers using this Lambda directly, on its own.

## Creating a client

Invoke the Lambda with a JSON payload. `username`, `clientSecret`, `contactName`, `clientEmail`, `square_access_token`, and `square_signature_key` are required — everything else is optional with a sensible default.

```bash
aws lambda invoke \
  --function-name client-setup-teardown \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "username": "newvenue",
    "clientSecret": "a-long-random-string-here",
    "contactName": "Jane Doe",
    "clientEmail": "jane@newvenue.example",
    "square_access_token": "EAAA...",
    "square_signature_key": "...",
    "theater_name": "New Venue Cinema"
  }' \
  --region your-region \
  result.json
cat result.json
```

| Field | Required | What it does if omitted |
|---|---|---|
| `username` | yes | — becomes the database name and the S3 bucket suffix. Must pass S3 bucket naming rules: 3-63 chars, lowercase letters/digits/dots/hyphens, starts and ends with a letter or digit, no `..`, not shaped like an IP address (`validateUsername` checks all of this up front and fails fast with a specific message) |
| `clientSecret` | yes | — this *is* the venue's login password (see "Logging in" below), not a person's password |
| `contactName` | yes | — a real person, not the venue's name |
| `clientEmail` | yes | — |
| `square_access_token` | yes | — |
| `square_signature_key` | yes | — |
| `theater_name` | no | defaults to `contactName` |
| `theater_id` | no | defaults to `"000000"` |
| `film_code_prefix` | no | derived automatically — explicit override if given (sanitized, 2-4 uppercase alphanumeric), else initials of `theater_name`, else the first 2 characters of `username`, else `"XX"` as a last resort. Used in box office report film codes (`bdor_for_date`'s Film Code column) |
| `s3_bucket_prefix` | no | defaults to `"indietix-"` |
| `sender_email` | no | defaults to `<contactname-no-spaces-lowercase>@indietix.net` |
| `admin_username`, `admin_password` | no, but together | creates a named, full-permission `Users` row in the same call — see "Logging in" below for why this is optional |
| `admin_email`, `admin_first_name`, `admin_last_name` | no | only used alongside `admin_username`/`admin_password`; `admin_email` defaults to `clientEmail` |
| `square_oauth` | no | `{ "merchant_id", "expires_at" }`. Sent by QRScanner's self-serve signup: puts the venue in Connect Square (OAuth) mode, whose refresh token is already in Secrets Manager |

What actually happens, in order: create the PostgreSQL user → create the database → build the full schema (`createDatabaseObjects` — every table, function, view, index a client gets; this function is the canonical source of truth for the schema, not any running database, which might be mid-migration or drifted) → grant permissions → create the Secrets Manager secret → insert the `Client` row with its default `configuration` JSON → create the two S3 buckets (`<prefix><username>` and `<prefix><username>-bdor`) and copy the ticket PDF templates into the main one → optionally insert the first admin user. A `statusCode: 200` response means all of it worked; `500` includes a `message` naming exactly what failed (e.g. a duplicate username).

**Logging in afterward needs no extra step.** The venue's own login works immediately: enter the `username` you chose as *both* the username and the client ID fields, and `clientSecret` as the password — the backend checks that directly against `Client.clientSecret`, no `Users` row involved. By convention this `username` has always been set to the venue's Square merchant ID in every real client so far (not a technical requirement, just the established pattern). The optional `admin_username`/`admin_password` fields exist only so day-to-day staff don't have to share that one root credential — skip them and use the client login, or create a named account later through the app's own User Management page, or seed one by hand (see infrastructure's `CLIENT_SETUP.md` for the `sql-runner` fallback).

## Deleting a client

```bash
aws lambda invoke \
  --function-name client-setup-teardown \
  --cli-binary-format raw-in-base64-out \
  --payload '{"delete_flag": true, "username": "newvenue"}' \
  --region your-region \
  result.json
```

Deletes, in order: the Secrets Manager secret (and the venue's Connect Square refresh-token secret, `indieTix/square/clients/<username>`, if it has one), both S3 buckets (objects first, then the buckets themselves — the bucket prefix is read from the client's own `Client.configuration` before the database is dropped, falling back to `"indietix-"` for any client onboarded before that field existed), then the database and PostgreSQL user. The response lists exactly what succeeded and what didn't, per step — a partial failure (e.g. a bucket that wouldn't empty) doesn't silently roll back everything else; check the response for what still needs manual cleanup.

**There's no confirmation step and no undo.** This is a direct, destructive action — treat the invoke itself as the point of no return, not something to script casually.

## Key files

- `src/index.js` — everything. `createDatabaseObjects` is the canonical schema definition; `insertClientRecord`'s `configuration` object is the canonical default config for a new client — if you're ever unsure what either should look like, this file is the answer, not a running database.
- `src/migrations.sql` — idempotent, append-only migration batches that bring *existing* clients up to whatever `createDatabaseObjects` already does for new ones. Must stay in sync by hand; nothing enforces that automatically.
- `nodejs/` — the Lambda layer (`node_modules`) for this function.

## Conventions worth knowing before changing this file

- **No foreign keys**, by deliberate convention — referential integrity is enforced in application code across the whole platform, not in the schema. (`SkeletonKeyUsage` is a grandfathered exception, predating the rule.)
- **Migrations must be idempotent** — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc. Both this file and `migrations.sql` need to stay safe to run twice.
- **Ticket templates come from a separate, non-client bucket** (`TICKET_TEMPLATES_BUCKET` env var, default `indietix-ticket-templates`) specifically so client teardown can never accidentally delete the shared templates. That bucket needs `ticket_horizontal.pdf` and `ticket_vertical.pdf` at its root before onboarding anyone, or the copy step fails.
