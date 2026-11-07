# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request:

- **GitHub:** the repository's **Security** tab → **Report a vulnerability** (private to the maintainers), or
- **Email:** indietix@indietix.net

Include what you found, how to reproduce it, and what it could affect. You'll get a reply within a few days. Please give us a reasonable chance to fix it before sharing it publicly.

## Scope

Everything in this repository: the Lambda functions, the operator app (QRScanner) and its public `/v1` API, the infrastructure templates and scripts, and the printer agent. A hosted IndieTix venue's live data is in scope too, but only test against your own installation or a venue that has given you permission.

Not in scope: Square, AWS, Meta, TikTok or other services IndieTix connects to (report those to them), and findings that need physical access to a venue's devices.

## Supported versions

`main` is the supported version. Fixes land there and are deployed from it.
