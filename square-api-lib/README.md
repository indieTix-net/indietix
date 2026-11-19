# square-api-lib

**Last Edited:** 2026-11-18

Shared Square REST API access for IndieTix, packaged as a Lambda layer.

## Why this exists

Every Lambda that talked to Square built its own URLs and auth headers: about 50 hand-rolled `fetch` calls across `getSquareOrders`, `QRScanner`, `expireQRCodeSquareModifiers`, `marketingEngine` and `squareTokenRefresher`, five separate copies of the `SQUARE_API_BASE` sandbox switch, two copies of the poster image upload and two of the catalog retrieve helper. All of them now go through this package, so there's one place that knows Square's address, the sandbox switch, and how the token is sent.

## What's in it

- `squareFetch(accessToken, path, init, { fetch })`: the base for every call. Builds the URL from `SQUARE_API_BASE` + `path` (query string included), adds `Authorization: Bearer <token>`, adds `Content-Type: application/json` when there's a string body, and returns Square's **raw Response**. Callers keep their own `response.ok` handling, which legitimately differs by call site (throw, return `"Unknown"`, send a 400/500 to the browser).
  - Pass `null` as the token for the OAuth token endpoint (`/oauth2/token`), which authenticates with the app's client secret in the body.
  - The optional 4th argument injects a fetch implementation (squareTokenRefresher's tests do).
- Catalog helpers: `retrieveCatalogObject`, `deleteCatalogObject`, `upsertCatalogObject`, `archiveItem` (all throw on non-OK), and `uploadCatalogImage` (multipart `POST /v2/catalog/images`, "file" then "request" part; returns the raw Response).
- `squareApiBase()`: `SQUARE_API_BASE` (sandbox) or Square's production address, read on every call.
- `isSquareSandbox()`: whether that base is Square's sandbox (QRScanner uses it for dashboard links and the OAuth page).

Every call takes the venue's Square access token as its first argument. Nothing is read from module state, so one venue's token can't end up on another venue's call. No missing-token check and no `Square-Version` header, matching the code it replaced.

No runtime dependencies: Node 22's global `fetch`/`FormData`/`Blob`, looked up at call time, so consumers' tests keep stubbing `globalThis.fetch`.

## What goes through it

| Lambda | Square APIs |
|---|---|
| QRScanner | catalog (search, list, object create/read, batch-retrieve, image upload), payments, refunds, inventory, locations, OAuth token |
| getSquareOrders | orders, payments, customers, catalog |
| expireQRCodeSquareModifiers | catalog (search, retrieve, delete, archive, update) |
| marketingEngine | catalog (search, retrieve) |
| squareTokenRefresher | OAuth token refresh |

Not in it, on purpose: `infrastructure/lib/square-webhook.py` (a Python deploy-time script with its own single `square()` helper; it can't import a JS package), and getSquareOrders' `WebhooksHelper` from Square's SDK (verifies incoming webhook signatures; not an outgoing call).

## Differences from the code it replaced

- **Poster upload transport.** QRScanner used `form-data`'s `.submit()` over raw `https`; this uses `fetch` with a native `FormData`. Same parts, same order, same auth. It also made the upload testable for the first time (QRScanner's `squareItemCreation` tests). **Verify a poster upload against the Square sandbox before the first production deploy.**
- **`Content-Type` on bodyless GETs.** Some call sites sent `Content-Type: application/json` on GETs with no body; `squareFetch` sends it only with a body. Square ignores it either way.
- **A null/undefined token** leaves the `Authorization` header off instead of sending `Bearer undefined`. Square answers 401 to both.

## Tests

```
npm install
npm test
```

## Using it

Consumers declare it as `"square-api-lib": "file:../square-api-lib"` (for tests) and get it at runtime from the `squareApiLib` Lambda layer:

```js
import * as squareApi from 'square-api-lib';
const response = await squareApi.squareFetch(token, `/v2/orders/${orderId}`, { method: 'GET' });
if (!response.ok) { /* this call site's own handling */ }
```

Consumers and their `infrastructure/lib/repo-config.sh` entries:

| Lambda | repo-config entry |
|---|---|
| expireQRCodeSquareModifiers | `square-api-lib` |
| marketingEngine | `square-api-lib-marketing-engine` |
| QRScanner | `square-api-lib-qrscanner` |
| getSquareOrders | `square-api-lib-get-square-orders` |
| squareTokenRefresher | none: bootstrap stack only, no production function |

`bootstrap.sh` publishes the layer once and passes it to all five stacks.

QRScanner and getSquareOrders now carry four layers each (own deps, `sms-utils`, `ticket-pdf-lib`, this). AWS allows five per function, so check `aws lambda get-function-configuration` in production first: if Lambda Insights is attached too, they'll be at the limit.

**Production rollout order:** publish the layer and attach it to every consumer *before* deploying any consumer's code. The code imports `square-api-lib` at load time and fails without the layer.

```bash
cd infrastructure
./deploy.sh deploy-layer square-api-lib                     # build + publish once
./deploy.sh attach-layer square-api-lib                     # -> expireQRCodeSquareModifiers
./deploy.sh attach-layer square-api-lib-marketing-engine    # -> marketingEngine
./deploy.sh attach-layer square-api-lib-qrscanner           # -> QRScanner
./deploy.sh attach-layer square-api-lib-get-square-orders   # -> getSquareOrders
./deploy.sh deploy expireQRCodeSquareModifiers
./deploy.sh deploy marketingEngine
./deploy.sh deploy QRScanner
./deploy.sh deploy getSquareOrders
```
