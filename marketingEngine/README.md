# marketingEngine

**Last Edited:** 2026-10-28

The "Marquee Engine" poller — turns a venue's Square catalog into scheduled marketing posts across email, Facebook, Instagram, and TikTok, with one human approval gate before anything actually sends.

## What it does

ESM Lambda, no HTTP interface, pure background poller — `src/index.mjs` is the whole thing. An EventBridge rule (`marketingEngine-poller`, `rate(5 minutes)`) invokes it every 5 minutes; it skips any client whose `Client.configuration.MARKETING_ENGINE_ENABLED` isn't `"true"`.

Each run does two things, in order:

1. **Generate drafts.** For every active, ticketed (`UseQRCode`) Square item with an enabled `MarketingSchedule`, it expands that schedule's configured day-offsets (relative to the item's opening showtime) into concrete `MarketingPost` rows with `Status = 'draft'`. Idempotent — a unique constraint on `(SquareItemID, Channel, PostType, ScheduledFor)` means re-running never duplicates a draft. It also resolves and attaches the item's existing Square catalog image to each draft. The weekly digest (one roundup post instead of per-item posts) is its own `PostType = 'digest'` with a sentinel `SquareItemID = 'digest'` — not a real Square object.
2. **Send due, approved posts.** Finds `MarketingPost` rows that are `Status = 'approved'` and past their `ScheduledFor` time, re-confirms the source item is still active in Square (skipped for digests), and sends — **every channel**, no exceptions carved out:
   - **Email** — raw MIME via SES, one send per active `MarketingEmailContact`. A partial failure across recipients still counts as a successful post; only an all-recipients failure throws.
   - **Facebook / Instagram** — real sends via the Meta Graph API, gated on `META_PAGE_ACCESS_TOKEN` + `META_PAGE_ID` (Facebook) and additionally `META_IG_BUSINESS_ID` (Instagram) being set in the client's config.
   - **TikTok** — real sends via the TikTok Content Posting API v2, gated on `TIKTOK_ACCESS_TOKEN`. Missing credentials for any channel falls back to a dry-run stub rather than failing — a venue can be onboarded before their social app access is approved without anything breaking.

Captions are template-based by default; a schedule can opt into AI-generated captions instead (`MarketingSchedule.UseAiCaptions`), prompted to avoid obvious AI tells (no rhetorical questions, no stock marketing phrases, at most one exclamation point, no em dashes).

## The one approval gate

**Approving a post is the entire review step, for every channel — there's no second checkpoint after that.** Once a `MarketingPost` is `Approved` and its scheduled time arrives, it sends automatically on the next poll. QRScanner's Marketing page also has a manual "Send Now" action for approve-and-send-immediately, but that's an optional override, not a required second step — nothing is held back from auto-sending by default once approved.

## TikTok token refresh

TikTok access tokens expire in roughly 24 hours, and TikTok's refresh tokens **rotate on every use** — the one just redeemed is dead the instant the exchange succeeds. So before every TikTok send, if `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` / `TIKTOK_REFRESH_TOKEN` are all set, this Lambda exchanges the refresh token for a new access+refresh pair and immediately persists both back to `Client.configuration` before using them. Skipping that persist step would permanently break the next refresh. If any of the three keys is missing, this is a no-op and a manually-pasted static `TIKTOK_ACCESS_TOKEN` keeps working as before — you only have to do the initial OAuth exchange once.

## Deployment notes

- Lambda layer dependencies (`src/nodejs/package.json`): `@aws-sdk/client-s3`, `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ses`, `pg`, `mailcomposer`, `sharp`, `dejavu-fonts-ttf`.
- Digest images render as SVG → JPEG via `sharp`. The **Electrolize** font (OFL-1.1) ships as function code (`src/fonts/Electrolize-Regular.ttf`, not a layer — `@fontsource/electrolize` only ships woff/woff2, which freetype can't load in a bare Lambda), with DejaVu Sans as a layer-provided fallback and a minimal `fonts.conf` written at module load.
- The execution role is shared with `DailyPgQueryAndSftp`'s nightly job; email sending needed its own narrowly-scoped `ses:SendRawEmail` policy added to that shared role.
- The EventBridge rule isn't defined in any IaC/template file in this repo — check the AWS console or `aws events describe-rule` for the live schedule rather than assuming this doc is current on timing.

See the repository-root `README.md` for the full platform architecture and multi-tenancy model.
