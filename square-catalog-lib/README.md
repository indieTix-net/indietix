# square-catalog-lib

**Last Edited:** 2026-11-18

Shared Square Catalog API helpers for IndieTix, packaged as a Lambda layer.

## Why this exists

`expireQRCodeSquareModifiers` carried its own fetch code for retrieving, deleting, archiving and updating Square catalog objects, and `marketingEngine` carried a second copy of the retrieve helper. Both now use this package. It is also where the Square calls for planned features (closing a showtime when it sells out, reopening it) will go, so `getSquareOrders` and `QRScanner` don't each grow their own copy.

## What's in it

- `retrieveCatalogObject(accessToken, objectId)`: GET the object with its related objects.
- `deleteCatalogObject(accessToken, objectId)`: DELETE an item, modifier list or modifier.
- `upsertCatalogObject(accessToken, { idempotency_key, object })`: create or update one object. Updates must carry the object's current `version`.
- `archiveItem(accessToken, itemId)`: re-read the item for its current version, then save it with `is_archived: true`.
- `squareApiBase()`: `SQUARE_API_BASE` (sandbox) or Square's production address, read on every call.

Every helper takes the venue's Square access token as its first argument. Nothing is read from a module-level config, so one venue's token can't end up on another venue's call. Behavior otherwise matches the copies it replaced exactly: same URLs, same error messages, and a non-OK response throws. No missing-token check, no `Square-Version` header.

No runtime dependencies: it uses Node 22's global `fetch`, looked up at call time, so consumers' tests can keep stubbing `globalThis.fetch`.

## Tests

```
npm install
npm test
```

## Using it

Consumers declare it as `"square-catalog-lib": "file:../square-catalog-lib"` (for tests) and get it at runtime from the `squareCatalogLib` Lambda layer:

```js
import * as squareCatalog from 'square-catalog-lib';
await squareCatalog.archiveItem(clientConfig.SQUARE_ACCESS_TOKEN, itemId);
```

Current consumers: `expireQRCodeSquareModifiers` (`square-catalog-lib` in `infrastructure/lib/repo-config.sh`) and `marketingEngine` (`square-catalog-lib-marketing-engine`). `bootstrap.sh` publishes the layer and passes it to both stacks.

**Production rollout order:** publish and attach the layer to each consumer *before* deploying that consumer's code. The code imports `square-catalog-lib` at load time and fails without the layer.

```bash
cd infrastructure
./deploy.sh deploy-layer square-catalog-lib                    # build + publish
./deploy.sh attach-layer square-catalog-lib                    # -> expireQRCodeSquareModifiers
./deploy.sh attach-layer square-catalog-lib-marketing-engine   # -> marketingEngine
./deploy.sh deploy expireQRCodeSquareModifiers
./deploy.sh deploy marketingEngine
```
