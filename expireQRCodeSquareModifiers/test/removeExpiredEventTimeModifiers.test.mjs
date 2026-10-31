import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { processClientModifiers } from '../src/index.mjs';

// Square's REST API is reached via the global `fetch`, not an SDK client,
// so a URL/method-aware router stubbed onto globalThis.fetch is the
// simplest reliable way to mock it -- more robust than a strict call-order
// queue, since the exact number/order of calls depends on how many
// categories match and how many modifier lists are found.
let originalFetch;
let routes;

function route(matcher, responseBody, { ok = true, status = 200 } = {}) {
  routes.push({ matcher, responseBody, ok, status });
}

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const match = routes.find(r => r.matcher(url, options.method || 'GET', body));
    if (!match) {
      throw new Error(`No mock route matched: ${options.method || 'GET'} ${url} body=${options.body}`);
    }
    return {
      ok: match.ok,
      status: match.status,
      json: async () => match.responseBody,
      text: async () => JSON.stringify(match.responseBody)
    };
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  routes = [];
});

function qrCodeItem({ id, name, modifierListId }) {
  return {
    type: 'ITEM',
    id,
    custom_attribute_values: { attr1: { name: 'UseQRCode', type: 'BOOLEAN', boolean_value: true } },
    item_data: {
      name,
      is_archived: false,
      modifier_list_info: [{ modifier_list_id: modifierListId }],
      variations: []
    }
  };
}

function mockCategoryAndItemSearch(items) {
  // Step 1a: category search -- one matching "Cinema" category.
  route(
    (url, method, body) => body?.object_types?.includes('CATEGORY'),
    { objects: [{ type: 'CATEGORY', id: 'cat-cinema', category_data: { name: 'Cinema' } }] }
  );
  // Step 1b: items search within that category.
  route(
    (url, method, body) => body?.object_types?.includes('ITEM') && body?.query?.exact_query?.attribute_value === 'cat-cinema',
    { objects: items, related_objects: [] }
  );
}

test('processClientModifiers: missing SQUARE_ACCESS_TOKEN is reported without making any Square API call', async () => {
  const result = await processClientModifiers({ clientId: 'no-token-client', configuration: {} });
  assert.equal(result.success, false);
  assert.equal(result.error, 'Missing Square Access Token');
});

test('processClientModifiers: no items found in target categories returns zeroed stats, not an error', async () => {
  mockCategoryAndItemSearch([]);

  const result = await processClientModifiers({
    clientId: 'empty-client',
    configuration: { SQUARE_ACCESS_TOKEN: 'token-1' }
  });

  assert.equal(result.success, true);
  assert.equal(result.itemsFound, 0);
  assert.equal(result.totalExpiredModifiersRemoved, 0);
});

test('removeExpiredEventTimeModifiers (via processClientModifiers): a modifier list whose name doesn\'t match the filter is skipped entirely', async () => {
  mockCategoryAndItemSearch([qrCodeItem({ id: 'item-1', name: 'Movie A', modifierListId: 'modlist-1' })]);
  route(
    (url, method) => method === 'GET' && url.includes('modlist-1'),
    { object: { id: 'modlist-1', version: 1, modifier_list_data: { name: 'Unrelated List', modifiers: [{ modifier_data: { name: 'Fri 01-01-2020 3:15 PM (Main)' } }] } } }
  );

  const result = await processClientModifiers({
    clientId: 'filter-mismatch-client',
    configuration: { SQUARE_ACCESS_TOKEN: 'token-2', MODIFIER_NAME_FILTER: 'Show Times' }
  });

  assert.equal(result.success, true);
  assert.equal(result.totalExpiredModifiersRemoved, 0);
  assert.equal(result.totalModifierListsDeleted, 0);
});

test('removeExpiredEventTimeModifiers (via processClientModifiers): ALL modifiers expired -> deletes the list and archives the item', async () => {
  mockCategoryAndItemSearch([qrCodeItem({ id: 'item-2', name: 'Old Movie', modifierListId: 'modlist-2' })]);

  route(
    (url, method) => method === 'GET' && url.includes('modlist-2'),
    { object: { id: 'modlist-2', version: 1, modifier_list_data: { name: 'Show Times', modifiers: [{ modifier_data: { name: 'Fri 01-01-2020 3:15 PM (Main)' } }] } } }
  );
  // archiveItem's own retrieveCatalogObject(itemId) call.
  route(
    (url, method) => method === 'GET' && url.includes('item-2'),
    { object: { id: 'item-2', version: 1, item_data: { name: 'Old Movie', is_archived: false } } }
  );
  // archiveItem's POST to update the item.
  route(
    (url, method, body) => method === 'POST' && body?.object?.type === 'ITEM',
    { catalog_object: { id: 'item-2', item_data: { is_archived: true } } }
  );
  // deleteCatalogObject('modlist-2').
  route(
    (url, method) => method === 'DELETE' && url.includes('modlist-2'),
    { deleted_object_ids: ['modlist-2'] }
  );

  const result = await processClientModifiers({
    clientId: 'all-expired-client',
    configuration: { SQUARE_ACCESS_TOKEN: 'token-3', MODIFIER_NAME_FILTER: 'Show Times' }
  });

  assert.equal(result.success, true);
  assert.equal(result.totalItemsArchived, 1);
  assert.equal(result.totalModifierListsDeleted, 1);
  assert.equal(result.totalExpiredModifiersRemoved, 1);
});

test('removeExpiredEventTimeModifiers (via processClientModifiers): SOME modifiers expired -> updates the list, keeps the active ones, does NOT archive the item', async () => {
  mockCategoryAndItemSearch([qrCodeItem({ id: 'item-3', name: 'Ongoing Movie', modifierListId: 'modlist-3' })]);

  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const futureStr = `${String(farFuture.getUTCMonth() + 1).padStart(2, '0')}-${String(farFuture.getUTCDate()).padStart(2, '0')}-${farFuture.getUTCFullYear()}`;

  route(
    (url, method) => method === 'GET' && url.includes('modlist-3'),
    {
      object: {
        id: 'modlist-3', version: 1,
        modifier_list_data: {
          name: 'Show Times',
          modifiers: [
            { modifier_data: { name: 'Fri 01-01-2020 3:15 PM (Main)' } }, // expired
            { modifier_data: { name: `Sat ${futureStr} 7:00 PM (Main)` } } // not expired
          ]
        }
      }
    }
  );
  let updateCalled = false;
  route(
    (url, method, body) => method === 'POST' && body?.object?.type === 'MODIFIER_LIST',
    { catalog_object: { id: 'modlist-3' } }
  );

  const result = await processClientModifiers({
    clientId: 'partial-expired-client',
    configuration: { SQUARE_ACCESS_TOKEN: 'token-4', MODIFIER_NAME_FILTER: 'Show Times' }
  });

  assert.equal(result.success, true);
  assert.equal(result.totalItemsArchived, 0, 'the item is still showing, not everything expired');
  assert.equal(result.totalModifierListsDeleted, 0);
  assert.equal(result.totalModifierListsUpdated, 1);
  assert.equal(result.totalExpiredModifiersRemoved, 1);
});
