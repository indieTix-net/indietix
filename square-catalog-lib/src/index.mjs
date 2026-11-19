// square-catalog-lib -- shared Square Catalog API helpers for IndieTix.
//
// Extracted from expireQRCodeSquareModifiers (retrieve/delete/archive/update)
// and marketingEngine (retrieve), which carried their own copies. Behavior is
// unchanged from those copies; the one deliberate difference is that the
// Square access token is passed in on every call instead of being read from a
// module-level `currentClientConfig`, so one venue's token can never leak into
// another venue's call from inside a shared module.
//
// Uses the global `fetch` (Node 22), looked up at call time, so callers' tests
// can keep stubbing `globalThis.fetch` exactly as before.

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

function catalogObjectUrl(objectId) {
  const base = `${squareApiBase()}/v2/catalog/object`;
  return objectId ? `${base}/${objectId}` : base;
}

// No missing-token check here on purpose: the copies this replaced sent
// whatever token they had and let Square answer 401, and this package keeps
// their behavior exactly.
function headers(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Retrieve one catalog object (with its related objects).
 * GET /v2/catalog/object/{id}?include_related_objects=true
 * @returns {Promise<object>} Square's response body ({ object, related_objects })
 */
export async function retrieveCatalogObject(accessToken, objectId) {
  try {
    const response = await fetch(`${catalogObjectUrl(objectId)}?include_related_objects=true`, {
      method: 'GET',
      headers: headers(accessToken)
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

    const response = await fetch(catalogObjectUrl(objectId), {
      method: 'DELETE',
      headers: headers(accessToken)
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
    const response = await fetch(catalogObjectUrl(), {
      method: 'POST',
      headers: headers(accessToken),
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

    const response = await fetch(catalogObjectUrl(), {
      method: 'POST',
      headers: headers(accessToken),
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
