# Creating a Client, Start to Finish

**Last Edited:** 2026-10-28

A "client" is one venue — its own database, its own S3 buckets, its own Secrets Manager entry, fully isolated from every other client. This walks through the two real scenarios: standing up your very first venue in a brand-new environment, and adding another venue to an environment that already exists. Both end at the same place — a working login and a checklist of what to configure next.

If you haven't deployed any infrastructure yet, start with the Setup & Deploy section of [README.md](./README.md) first. This doc picks up from "the infrastructure exists."

## Scenario A: brand-new environment, first client

`bootstrap.sh up` does this in one shot — it deploys all 12 stacks in dependency order *and* onboards your first client at the end, from the values in `bootstrap.config.sh` (copy from `bootstrap.config.sh.template`; see that file's comments for every field).

**Easiest path:** set `SQUARE_WEBHOOK_AUTO="true"` in `bootstrap.config.sh` (see the template's "Square webhook" section and README's "Connecting Square"). `up` then creates the Square webhook subscription itself, right after the webhook endpoint deploys, and passes its signature key, the webhook URL, and the location to onboarding. One run, no signature key to copy by hand.

Without it, the one real gotcha: `client-setup-teardown`'s handler **hard-requires a real Square access token and signature key just to create the client row at all** — not optional, not something you fill in later through Client Settings for this first client. So even though README.md's walkthrough otherwise treats Square setup as a later step, for this one call you need a Square app already created first (see README's "Connecting Square" section for how to get the token). If you don't have the signature key yet because it depends on knowing the webhook URL, which depends on having deployed — run `bootstrap.sh up` once, note the webhook endpoint it prints, register that in Square to get the signature key, fill it into `bootstrap.config.sh`, and run `up` again. CloudFormation only applies the diff on stacks that haven't changed, and the client-onboarding invoke is safe to repeat (fails cleanly with "role already exists" if the client row is already there, doesn't corrupt anything — confirmed live).

```
cd infrastructure
cp bootstrap.config.sh.template bootstrap.config.sh
# edit bootstrap.config.sh with your real values
./bootstrap.sh up
```

Skip to [After onboarding](#after-onboarding) below once it completes.

## Scenario B: adding another client to an existing environment

`bootstrap.sh up` only ever onboards *the first* client for a given `ENV_PREFIX` — every client after that is a direct, one-off invoke of the already-deployed `client-setup-teardown` Lambda with that new venue's details. This is exactly what `bootstrap.sh` itself does internally; you're just doing it by hand for client #2, #3, etc.

The handler's full parameter list (from `clientSetup-Teardown/src/index.js`'s `exports.handler`):

| Field | Required? | Notes |
|---|---|---|
| `username` | yes | Becomes the DB name and S3 bucket suffix — lowercase, 3-63 chars, letters/numbers/dots/hyphens, must start+end with a letter/number (S3 bucket naming rules) |
| `clientSecret` | yes | The client-level login secret — a long random string, effectively a root credential for this client, not a person's password |
| `contactName` | yes | A real person's name, not the venue's name |
| `clientEmail` | yes | Real email, used for login/notifications |
| `square_access_token` | yes | From this venue's own Square application |
| `square_signature_key` | yes | From this venue's own Square webhook subscription |
| `square_webhook_url` | no | This environment's webhook endpoint (`square-queue-forwarder`'s `ApiEndpoint` output). Sets `SQUARE_WEBHOOK_URL`, which has to match the subscription exactly for signature checks. Blank if omitted; `bootstrap.sh up` always passes it |
| `square_location_id` | no | Sets `SQUARE_LOCATION_ID`. Blank if omitted; set it later in Client Settings |
| `settings` | no | An object of initial Client Settings, using Client Settings' own key names (e.g. `OMDB_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `FTP1_HOST`). Only user-definable keys are applied; others are skipped and named in the log, values never logged. Explicit `square_*` fields above win over the same keys here. `bootstrap.sh` fills this from `FIRST_CLIENT_SETTINGS_FILE` |
| `theater_name` | no | Defaults to `contactName` if omitted — shown in reports and web branding unless overridden later |
| `theater_id` | no | Defaults to `"000000"` |
| `film_code_prefix` | no | Auto-derived from theater name/username initials if omitted — used in box office report film codes |
| `s3_bucket_prefix` | no | Defaults to `"indietix-"` — **must match this environment's actual prefix** (your `ENV_PREFIX` plus a trailing hyphen) or the client's buckets won't be found by anything else later |
| `sender_email` | no | Defaults to `<contactname>@indietix.net` |
| `admin_username`, `admin_password` | no, but together | Creates a named, full-permission `Users` row in the same step — see [After onboarding](#after-onboarding) below for why this is optional, not required to log in |
| `admin_email`, `admin_first_name`, `admin_last_name` | no | Only used if `admin_username`/`admin_password` are set; `admin_email` defaults to `clientEmail` |

Build the payload and invoke (replace `<env-prefix>` and the bracketed values):

```bash
aws lambda invoke \
  --function-name "<env-prefix>-client-setup-teardown" \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "username": "newvenue",
    "clientSecret": "a-long-random-string-here",
    "contactName": "Jane Doe",
    "clientEmail": "jane@newvenue.example",
    "square_access_token": "EAAA...",
    "square_signature_key": "...",
    "theater_name": "New Venue Cinema",
    "s3_bucket_prefix": "<env-prefix>-"
  }' \
  --region <your-region> \
  result.json
cat result.json
```

A `statusCode: 200` body confirms the database, schema, Secrets Manager secret, and S3 buckets all got created; a `500` with a message tells you exactly what failed (e.g. a username collision). Check CloudWatch logs for `<env-prefix>-client-setup-teardown` if the message alone isn't enough to go on.

## After onboarding

At this point the client **exists** — database, schema, buckets, a `Client` row with sensible defaults — and you can actually log in right away, with no extra step:

**You already have a working login.** The login form takes `username`, `password`, and `clientId`. When `username` equals `clientId`, the backend checks `password` against `Client.clientSecret` directly — no `Users` row involved at all. So the `username` you picked at onboarding (enter it as both the username *and* the client ID) plus the `clientSecret` you set at the same time already gets you in, with full access. By convention this `username` has always been set to the venue's Square merchant ID (e.g. Liberty Hall's is `M5E5N7KAHZA7Q`) — not a technical requirement, just the pattern every real client so far has followed.

**Optional: give yourself (or staff) a named account instead of sharing that root credential day to day.** As of this write-up, `client-setup-teardown`'s onboarding payload accepts optional `admin_username`, `admin_password`, `admin_email` (plus optional `admin_first_name`/`admin_last_name`) — supply them together (both-or-neither; a 400 if only one is set) and it creates a full-permission `Users` row in the same step as everything else, no extra call needed:

```json
{
  "username": "newvenue",
  "...": "...(the rest of the create payload from above)...",
  "admin_username": "jane",
  "admin_password": "a-different-long-random-string",
  "admin_email": "jane@newvenue.example",
  "admin_first_name": "Jane",
  "admin_last_name": "Doe"
}
```

The response's `adminUserCreated` field confirms whether this ran. Skip these fields entirely and use the client login instead if you'd rather not bother — nothing downstream requires a named account to exist.

**If you've already onboarded a client without these fields** and want a named account after the fact, either log in with the client credential and create one normally through User Management, or seed one directly: `sql-runner` (`<env-prefix>-sql-runner`, deployed alongside `client-setup-teardown` in every environment specifically for one-off SQL like this, since Aurora has no public access for a direct `psql` session) runs one parameterized statement against a named client database.

```bash
# 1. Hash a password (bcryptjs, 10 rounds -- matches every password hash in this platform)
node -e "require('bcryptjs').hash(process.argv[1], 10).then(h => console.log(h))" 'your-chosen-password'

# 2. Insert the user, using that hash
aws lambda invoke \
  --function-name "<env-prefix>-sql-runner" \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "database": "newvenue",
    "sql": "INSERT INTO \"Users\" (\"Username\", \"Password\", \"Email\", \"FirstName\", \"LastName\", \"Permissions\") VALUES ($1, $2, $3, $4, $5, $6)",
    "params": ["jane", "<the bcrypt hash from step 1>", "jane@newvenue.example", "Jane", "Doe", {"view": true, "edit": true, "checkIn": true, "marketing": true, "admin": true}]
  }' \
  --region <your-region> \
  result.json
```

**Log in** at the static site's URL (`bootstrap.sh`'s summary output prints it, or check the `static-site` stack's `BucketName`/CloudFront distribution for an existing environment) with either the client credential (`username` = `clientId` = the value from onboarding, `password` = `clientSecret`) or a named account's username/password.

**4. Configure the integrations this venue actually wants**, via Client Settings — see README.md's "Connecting Square," "Connecting Google Calendar," "Connecting Social Media," and "Printing Tickets" sections for each one. None of them are required to start selling tickets beyond the Square credentials already provided at onboarding; everything else is additive.

**5. Create your first movie or event** through Movie Info Lookup or Event Info Entry — this builds the actual Square catalog item (ticketed-item flag, distributor/event-type attributes, showtime modifier) for you, so there's no need to hand-build anything in the Square dashboard itself.
