// square-catalog-lib -- shared Square Catalog API access for IndieTix.
//
// Every Square Catalog call in the platform goes through this package:
// getSquareOrders, QRScanner, expireQRCodeSquareModifiers and marketingEngine
// each used to build their own URLs and headers.
//
// Two layers:
//  - catalogFetch(token, path, init): builds the URL from SQUARE_API_BASE,
//    adds the auth header, and returns Square's raw Response. Callers keep
//    their own response.ok handling, which differs a lot by call site (throw,
//    return "Unknown", send a 500 to the browser, ...).
//  - retrieve/delete/upsert/archive and uploadCatalogImage: helpers on top.
//
// The Square access token is passed on every call, never read from module
// state, so one venue's token can't leak into another venue's call.
//
// Uses the global `fetch` (Node 22), looked up at call time, so callers'
// tests can keep stubbing `globalThis.fetch` (or intercepting with nock).

// ---- SQUARE API BASE ----
// Square's production API unless SQUARE_API_BASE says otherwise: an
// environment pointed at Square's sandbox sets it to
// https://connect.squareupsandbox.com (bootstrap.sh, SQUARE_ENVIRONMENT).
// Read on every call rather than once at load, so it always matches the
// consuming Lambda's current environment.
export function squareApiBase() {
  return (process.env.SQUARE_API_BASE || 'https://connect.squareup.com').replace(/\/+$/, '');
}
// ---- END SQUARE API BASE ----

/**
 * Call a Square Catalog endpoint and return the raw fetch Response.
 *
 * @param {string} accessToken  the venue's Square access token
 * @param {string} path         e.g. '/v2/catalog/search' or
 *                              `/v2/catalog/object/${id}?include_related_objects=true`
 * @param {object} [init]       fetch init: { method, body, headers }. A string
 *                              body is sent as JSON (Content-Type added). Any
 *                              headers given are added to the auth header.
 *
 * No missing-token check on purpose: the call sites this replaced sent
 * whatever token they had and let Square answer 401.
 */
export function catalogFetch(accessToken, path, init = {}) {
  const headers = { 'Authorization': `Bearer ${accessToken}` };
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  return fetch(`${squareApiBase()}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) }
  });
}

/**
 * Retrieve one catalog object (with its related objects).
 * GET /v2/catalog/object/{id}?include_related_objects=true
 * @returns {Promise<object>} Square's response body ({ object, related_objects })
 */
export async function retrieveCatalogObject(accessToken, objectId) {
  try {
    const response = await catalogFetch(accessToken, `/v2/catalog/object/${objectId}?include_related_objects=true`, {
      method: 'GET'
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to retrieve catalog object ${objectId}: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error retrieving catalog object ${objectId}:`, error);
    throw error;
  }
}

/**
 * Delete one catalog object (an item, modifier list, modifier, ...).
 * DELETE /v2/catalog/object/{id}
 * @returns {Promise<object>} Square's response body ({ deleted_object_ids, deleted_at })
 */
export async function deleteCatalogObject(accessToken, objectId) {
  try {
    console.log(`Deleting catalog object: ${objectId}`);

    const response = await catalogFetch(accessToken, `/v2/catalog/object/${objectId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete catalog object ${objectId}: ${response.status} ${errorText}`);
    }

    const deleteData = await response.json();
    console.log(`Successfully deleted catalog object: ${objectId}`);
    return deleteData;
  } catch (error) {
    console.error(`Error deleting catalog object ${objectId}:`, error);
    throw error;
  }
}

/**
 * Create or update one catalog object.
 * POST /v2/catalog/object with { idempotency_key, object }.
 * Updates must carry the object's current `version` (Square rejects stale ones).
 * @returns {Promise<object>} Square's response body ({ catalog_object, id_mappings })
 */
export async function upsertCatalogObject(accessToken, catalogObjectRequest) {
  try {
    const response = await catalogFetch(accessToken, '/v2/catalog/object', {
      method: 'POST',
      body: JSON.stringify(catalogObjectRequest)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update catalog object: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error updating catalog object:`, error);
    throw error;
  }
}

/**
 * Archive an item: re-read it for its current version, then save it back
 * with is_archived: true. Archiving hides it from the POS and online store
 * but keeps it in the catalog, so past orders still resolve.
 * @returns {Promise<object>} Square's response body from the update
 */
export async function archiveItem(accessToken, itemId) {
  try {
    console.log(`Archiving item: ${itemId}`);

    // First get the current item to get the version and data
    const currentItem = await retrieveCatalogObject(accessToken, itemId);

    if (!currentItem.object) {
      throw new Error(`Could not retrieve item ${itemId} for archiving`);
    }

    // Use snake_case for REST API
    const updatePayload = {
      idempotency_key: `archive-${itemId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      object: {
        type: 'ITEM',
        id: itemId,
        version: currentItem.object.version,
        item_data: {
          ...currentItem.object.item_data,
          is_archived: true
        }
      }
    };

    const response = await catalogFetch(accessToken, '/v2/catalog/object', {
      method: 'POST',
      body: JSON.stringify(updatePayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to archive item ${itemId}: ${response.status} ${errorText}`);
    }

    const archiveData = await response.json();
    console.log(`Successfully archived item: ${itemId}`);
    return archiveData;
  } catch (error) {
    console.error(`Error archiving item ${itemId}:`, error);
    throw error;
  }
}

/**
 * Upload an image to the catalog (multipart): POST /v2/catalog/images.
 * Returns the raw Response, like catalogFetch, so the caller decides what a
 * failure means (QRScanner's Add Movie / Add Event just log and carry on
 * without a poster).
 *
 * Replaces QRScanner's two copies of a form-data `.submit()` upload. Same
 * parts, same order ("file" then "request"), now over the global fetch, which
 * also makes it testable.
 *
 * @param {string} accessToken
 * @param {object} upload
 * @param {Buffer|Uint8Array} upload.imageBuffer
 * @param {string} upload.filename      e.g. 'the_glass_orchard_poster.jpg'
 * @param {string} [upload.contentType] defaults to 'image/jpeg'
 * @param {object} upload.request       { idempotency_key, image: { id, type: 'IMAGE', image_data } }
 */
export function uploadCatalogImage(accessToken, { imageBuffer, filename, contentType = 'image/jpeg', request }) {
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: contentType }), filename);
  form.append('request', JSON.stringify(request));
  // No Content-Type here: fetch sets multipart/form-data with its boundary.
  return fetch(`${squareApiBase()}/v2/catalog/images`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` },
    body: form
  });
}
