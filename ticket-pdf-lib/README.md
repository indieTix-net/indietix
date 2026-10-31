# ticket-pdf-lib

**Last Edited:** 2026-10-28

Shared QR-code generation and ticket-PDF rendering logic, packaged as a Lambda layer.

## Why this exists

`getSquareOrders` used to have its own working copy of this logic (QR code generation, overlaying a QR code + ticket details onto a template PDF, S3 read/write) that runs on every real ticket sale. QRScanner's ticket-transfer feature needed the exact same capability — generating a *new* ticket PDF for a transfer recipient — but didn't have any way to do that before this existed.

Rather than duplicate ~300 lines of intricate PDF-layout code into QRScanner's own `app.mjs` (the project's usual pattern for small utilities, but this is a much bigger and more consequential chunk), this is a fresh, parameterized port of that same logic, built as a real Lambda layer from the start — proving the shared-layer pattern out properly in QRScanner's transfer feature (a deliberately lower-stakes consumer) before migrating `getSquareOrders` itself onto it.

**Status (2026-10-25): `getSquareOrders` has now been migrated too.** Its old `generateQRCode`/`overlayQRCodeOnPdf`/`getPdfFromS3`/`savePdfToS3` were confirmed line-for-line equivalent to this package's `generateQRCode`/`renderTicketPdf`/`fetchPdfFromS3`/`savePdfToS3` (including both the main-ticket and SMS-specific-vertical render paths) before being removed in favor of importing this package directly. Code-complete, locally verified against the real production ticket templates, and committed — but the actual layer-attach + Lambda deploy is deliberately held until a lower-traffic window (Sunday show days aren't it) rather than being pushed the moment the code is ready.

## What's in it

- `generateQRCode(data)` — renders a string as a QR code PNG buffer.
- `renderTicketPdf(templatePdfBuffer, qrCodeBuffer, orderInfo, orientation)` — overlays a QR code and ticket details onto a template PDF. Supports `'horizontal'` (1800×600) and `'vertical'` (600×1800) layouts, matching the two real ticket templates in production. Pure function, no AWS calls.
- `fetchPdfFromS3(s3Client, bucket, key)` / `savePdfToS3(s3Client, bucket, key, pdfBuffer)` — thin S3 read/write helpers. Take an already-configured `S3Client` as a parameter rather than constructing their own, so the caller's existing client (same region/credentials it uses everywhere else) is reused as-is.

`@aws-sdk/client-s3` is a peer dependency, not bundled — the consuming Lambda's own layer already provides it (Lambda layers share a `node_modules` resolution path across every attached layer), so this one doesn't need its own copy.

## Tests

```
npm install
npm test
```

Covers both orientations, missing optional fields, and the real edge cases in the text-wrapping algorithm (very long titles that need truncation, a single word wider than the wrap width). Also manually verified against the real production ticket templates (not just synthetic test fixtures) before this was trusted for anything.

No binary PDF fixtures are committed — tests build a blank template at the real ticket dimensions on the fly using `pdf-lib` itself.

## Using this as a Lambda layer

Same `deploy-layer`/`attach-layer` pattern the platform already uses for dependency layers (see `infrastructure/DEPLOY.md`). Package `src/` + `node_modules/` (minus devDependencies) as the layer content, attach it to the consuming function, then import from the layer's mount path at runtime (`/opt/nodejs/...` on Node.js Lambdas).
