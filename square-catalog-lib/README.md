# square-catalog-lib

**Last Edited:** 2026-11-18

Shared Square Catalog API access for IndieTix, packaged as a Lambda layer.

## Why this exists

Every Lambda that talked to Square's catalog built its own URLs and auth headers: about 35 hand-rolled `fetch` calls across `getSquareOrders`, `QRScanner`, `expireQRCodeSquareModifiers` and `marketingEngine`, plus two copies of the poster image upload and two copies of the retrieve helper. All of them now go through this package, so there is one place that knows Square's catalog URLs, the sandbox switch, and how the token is sent.

## What's in it

- `catalogFetch(accessToken, path, init)`: the base of everything. Builds the URL from `SQUARE_API_BASE` + `path` (query string included, e.g. `/v2/catalog/list?types=CATEGORY`), adds `Authorization`, adds `Content-Type: application/json` when there's a string body, and returns Square's **raw Response**. Callers keep their own `response.ok` handling, which legitimately differs by call site (throw, return `"Unknown"`, send a 500 to the browser).
- `retrieveCatalogObject(accessToken, objectId)`: GET with related objects; throws on non-OK.
- `deleteCatalogObject(accessToken, objectId)`: throws on non-OK.
- `upsertCatalogObject(accessToken, { idempotency_key, object })`: create or update. Updates must carry the current `version`.
- `archiveItem(accessToken, itemId)`: re-read for the version, save with `is_archived: true`.
- `uploadCatalogImage(accessToken, { imageBuffer, filename, contentType, request })`: multipart `POST /v2/catalog/images` ("file" part, then the JSON "request" part). Returns the raw Response.
- `squareApiBase()`: `SQUARE_API_BASE` (sandbox) or Square's production address, read on every call.

Every function takes the venue's Square access token as its first argument. Nothing is read from module state, so one venue's token can't end up on another venue's call. No missing-token check and no `Square-Version` header, matching the code it replaced.

No runtime dependencies: it uses Node 22's global `fetch`/`FormData`/`Blob`, looked up at call time, so consumers' tests keep stubbing `globalThis.fetch`.

## Differences from the code it replaced

- **Poster upload transport.** QRScanner used `form-data`'s `.submit()` over raw `https`; this uses `fetch` with a native `FormData`. Same parts, same order, same auth. It also made the upload testable for the first time: QRScanner's `squareItemCreation` tests now cover it. **Verify a poster upload against the Square sandbox before the first production deploy.**
- **`Content-Type` on bodyless GETs.** Some call sites sent `Content-Type: application/json` on GETs with no body and some didn't; `catalogFetch` sends it only with a body. Square ignores it either way.

## Tests

```
npm install
npm test
```

## Using it

Consumers declare it as `"square-catalog-lib": "file:../square-catalog-lib"` (for tests) and get it at runtime from the `squareCatalogLib` Lambda layer:

```js
import * as squareCatalog from 'square-catalog-lib';
const response = await squareCatalog.catalogFetch(token, '/v2/catalog/search', {
  method: 'POST',
  body: JSON.stringify({ object_types: ['ITEM'], include_related_objects: true })
});
if (!response.ok) { /* this call site's own handling */ }
```

Consumers and their `infrastructure/lib/repo-config.sh` entries:

| Lambda | repo-config entry |
|---|---|
| expireQRCodeSquareModifiers | `square-catalog-lib` |
| marketingEngine | `square-catalog-lib-marketing-engine` |
| QRScanner | `square-catalog-lib-qrscanner` |
| getSquareOrders | `square-catalog-lib-get-square-orders` |

`bootstrap.sh` publishes the layer and passes it to all four stacks.

QRScanner and getSquareOrders now carry four layers each (own deps, `sms-utils`, `ticket-pdf-lib`, this). AWS allows five per function, so check `aws lambda get-function-configuration` in production first: if Lambda Insights is attached too, they'll be at the limit.

**Production rollout order:** publish the layer and attach it to every consumer *before* deploying any consumer's code. The code imports `square-catalog-lib` at load time and fails without the layer.

```bash
cd infrastructure
./deploy.sh deploy-layer square-catalog-lib                     # build + publish once
./deploy.sh attach-layer square-catalog-lib                     # -> expireQRCodeSquareModifiers
./deploy.sh attach-layer square-catalog-lib-marketing-engine    # -> marketingEngine
./deploy.sh attach-layer square-catalog-lib-qrscanner           # -> QRScanner
./deploy.sh attach-layer square-catalog-lib-get-square-orders   # -> getSquareOrders
./deploy.sh deploy expireQRCodeSquareModifiers
./deploy.sh deploy marketingEngine
./deploy.sh deploy QRScanner
./deploy.sh deploy getSquareOrders
```
