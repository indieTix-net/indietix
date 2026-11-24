import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  squareApiBase,
  retrieveCatalogObject,
  deleteCatalogObject,
  upsertCatalogObject,
  archiveItem,
  unarchiveItem,
  squareFetch,
  uploadCatalogImage
} from '../src/index.mjs';

// Every call goes through the global fetch, so a URL/method-recording stub on
// globalThis.fetch is all the infrastructure these need.
let calls;
let responder;
let originalFetch;
let originalBase;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  calls = [];
  responder = () => jsonResponse({});
  originalFetch = globalThis.fetch;
  originalBase = process.env.SQUARE_API_BASE;
  delete process.env.SQUARE_API_BASE;
  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    const call = { url: String(url), method: options.method, headers: options.headers, body };
    calls.push(call);
    return responder(call);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.SQUARE_API_BASE;
  else process.env.SQUARE_API_BASE = originalBase;
});

test('src/index.mjs: production Square address appears only as the SQUARE_API_BASE default', async () => {
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const hits = source.split('\n').filter((line) => line.includes('connect.squareup.com'));
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /process\.env\.SQUARE_API_BASE \|\| 'https:\/\/connect\.squareup\.com'/);
});

test('squareApiBase: production by default, sandbox when set, trailing slashes trimmed, read at call time', () => {
  assert.equal(squareApiBase(), 'https://connect.squareup.com');
  process.env.SQUARE_API_BASE = 'https://connect.squareupsandbox.com//';
  assert.equal(squareApiBase(), 'https://connect.squareupsandbox.com');
});

test('retrieveCatalogObject: GETs the object with related objects, using the token it was given', async () => {
  responder = () => jsonResponse({ object: { id: 'OBJ1' } });
  const result = await retrieveCatalogObject('tok-A', 'OBJ1');
  assert.deepEqual(result, { object: { id: 'OBJ1' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://connect.squareup.com/v2/catalog/object/OBJ1?include_related_objects=true');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-A');
});

test('retrieveCatalogObject: honors SQUARE_API_BASE (sandbox)', async () => {
  process.env.SQUARE_API_BASE = 'https://connect.squareupsandbox.com/';
  await retrieveCatalogObject('tok', 'OBJ1');
  assert.match(calls[0].url, /^https:\/\/connect\.squareupsandbox\.com\/v2\/catalog\/object\/OBJ1/);
});

test('retrieveCatalogObject: a non-OK response throws with the status and body', async () => {
  responder = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'NOT_FOUND' });
  await assert.rejects(retrieveCatalogObject('tok', 'GONE'), /Failed to retrieve catalog object GONE: 404 NOT_FOUND/);
});

test('each venue\'s token goes only on its own call', async () => {
  await retrieveCatalogObject('tok-venue-A', 'OBJ1');
  await deleteCatalogObject('tok-venue-B', 'OBJ2');
  await upsertCatalogObject('tok-venue-C', { object: {} });
  assert.deepEqual(calls.map((c) => c.headers.Authorization),
    ['Bearer tok-venue-A', 'Bearer tok-venue-B', 'Bearer tok-venue-C']);
});

test('deleteCatalogObject: DELETEs the object and returns Square\'s body', async () => {
  responder = () => jsonResponse({ deleted_object_ids: ['MOD1'] });
  const result = await deleteCatalogObject('tok', 'MOD1');
  assert.deepEqual(result, { deleted_object_ids: ['MOD1'] });
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://connect.squareup.com/v2/catalog/object/MOD1');
});

test('deleteCatalogObject: a non-OK response throws (unchanged from the original copy)', async () => {
  responder = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'NOT_FOUND' });
  await assert.rejects(deleteCatalogObject('tok', 'MOD1'), /Failed to delete catalog object MOD1: 404/);
});

test('upsertCatalogObject: POSTs the request body as given', async () => {
  const request = { idempotency_key: 'k1', object: { type: 'ITEM', id: 'ITEM1', version: 7 } };
  responder = () => jsonResponse({ catalog_object: { id: 'ITEM1', version: 8 } });
  const result = await upsertCatalogObject('tok', request);
  assert.equal(result.catalog_object.version, 8);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://connect.squareup.com/v2/catalog/object');
  assert.deepEqual(calls[0].body, request);
});

test('archiveItem: re-reads the item, then saves the whole object back at that version with is_archived true', async () => {
  responder = (call) => call.method === 'GET'
    ? jsonResponse({ object: { type: 'ITEM', id: 'ITEM1', version: 42, present_at_location_ids: ['LOC1'], custom_attribute_values: { indietix_use_qr: { boolean_value: true } }, item_data: { name: 'The Glass Orchard', is_archived: false } } })
    : jsonResponse({ catalog_object: { id: 'ITEM1' } });

  await archiveItem('tok', 'ITEM1');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/v2\/catalog\/object\/ITEM1\?include_related_objects=true$/);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://connect.squareup.com/v2/catalog/object');
  assert.match(calls[1].body.idempotency_key, /^archive-ITEM1-/);
  assert.deepEqual(calls[1].body.object, {
    type: 'ITEM',
    id: 'ITEM1',
    version: 42,
    present_at_location_ids: ['LOC1'],
    custom_attribute_values: { indietix_use_qr: { boolean_value: true } },
    item_data: { name: 'The Glass Orchard', is_archived: true }
  });
});

test('archiveItem: throws if Square returns no object to archive', async () => {
  responder = () => jsonResponse({});
  await assert.rejects(archiveItem('tok', 'ITEM1'), /Could not retrieve item ITEM1 for archiving/);
  assert.equal(calls.length, 1);
});

test('squareFetch: builds the URL from the path (query strings kept) and returns the raw response', async () => {
  const raw = jsonResponse({ objects: [] }, { ok: false, status: 503 });
  responder = () => raw;
  const response = await squareFetch('tok', '/v2/catalog/list?types=CATEGORY&cursor=abc');
  assert.equal(response, raw, 'caller gets the response itself, not a thrown error');
  assert.equal(calls[0].url, 'https://connect.squareup.com/v2/catalog/list?types=CATEGORY&cursor=abc');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
});

test('squareFetch: JSON Content-Type only when there is a body; extra headers are merged in', async () => {
  await squareFetch('tok', '/v2/catalog/object/OBJ1', { method: 'GET' });
  await squareFetch('tok', '/v2/catalog/search', { method: 'POST', body: JSON.stringify({ object_types: ['ITEM'] }), headers: { 'X-Extra': '1' } });
  assert.deepEqual(calls[0].headers, { Authorization: 'Bearer tok' });
  assert.deepEqual(calls[1].headers, { Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'X-Extra': '1' });
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].body, { object_types: ['ITEM'] });
});

test('squareFetch: honors SQUARE_API_BASE (sandbox)', async () => {
  process.env.SQUARE_API_BASE = 'https://connect.squareupsandbox.com';
  await squareFetch('tok', '/v2/catalog/batch-retrieve', { method: 'POST', body: '{}' });
  assert.equal(calls[0].url, 'https://connect.squareupsandbox.com/v2/catalog/batch-retrieve');
});

test('uploadCatalogImage: multipart POST with the image file then the JSON request part', async () => {
  const raw = jsonResponse({ image: { id: 'IMG1' } });
  responder = () => raw;
  const request = { idempotency_key: 'k', image: { id: '#img', type: 'IMAGE', image_data: { caption: 'Poster' } } };
  const response = await uploadCatalogImage('tok', {
    imageBuffer: Buffer.from([0xff, 0xd8, 0xff]),
    filename: 'poster.jpg',
    request
  });
  assert.equal(response, raw);
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://connect.squareup.com/v2/catalog/images');
  assert.deepEqual(call.headers, { Authorization: 'Bearer tok' }, 'no Content-Type: fetch sets the multipart boundary');
  assert.ok(call.body instanceof FormData);
  assert.deepEqual([...call.body.keys()], ['file', 'request']);
  const file = call.body.get('file');
  assert.equal(file.name, 'poster.jpg');
  assert.equal(file.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0xff, 0xd8, 0xff]);
  assert.deepEqual(JSON.parse(call.body.get('request')), request);
});

test('squareFetch: any Square endpoint, not just the catalog', async () => {
  await squareFetch('tok', '/v2/orders/ORDER1');
  await squareFetch('tok', '/v2/refunds', { method: 'POST', body: JSON.stringify({ payment_id: 'P1' }) });
  assert.equal(calls[0].url, 'https://connect.squareup.com/v2/orders/ORDER1');
  assert.equal(calls[1].url, 'https://connect.squareup.com/v2/refunds');
  assert.deepEqual(calls[1].body, { payment_id: 'P1' });
});

test('squareFetch: a null token (OAuth token endpoint) sends no Authorization header', async () => {
  await squareFetch(null, '/oauth2/token', { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token' }) });
  assert.equal(calls[0].url, 'https://connect.squareup.com/oauth2/token');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json' });
});

test('squareFetch: uses an injected fetch instead of the global one', async () => {
  const injected = [];
  const fakeFetch = async (url, init) => { injected.push({ url, init }); return jsonResponse({ access_token: 'new' }); };
  const response = await squareFetch(null, '/oauth2/token', { method: 'POST', body: '{}' }, { fetch: fakeFetch });
  assert.deepEqual(await response.json(), { access_token: 'new' });
  assert.equal(injected.length, 1);
  assert.equal(injected[0].url, 'https://connect.squareup.com/oauth2/token');
  assert.equal(calls.length, 0, 'global fetch not used');
});

test('unarchiveItem: re-reads the item and saves the whole object back with is_archived false', async () => {
  const item = {
    type: 'ITEM', id: 'ITEM1', version: 43, present_at_location_ids: ['LOC1'],
    custom_attribute_values: { indietix_use_qr: { boolean_value: true } },
    item_data: { name: 'The Glass Orchard', is_archived: true, modifier_list_info: [{ modifier_list_id: 'ML1' }] }
  };
  responder = (call) => call.method === 'GET' ? jsonResponse({ object: item }) : jsonResponse({ catalog_object: { id: 'ITEM1' } });

  await unarchiveItem('tok', 'ITEM1');

  assert.equal(calls.length, 2);
  assert.match(calls[1].body.idempotency_key, /^unarchive-ITEM1-/);
  assert.deepEqual(calls[1].body.object, { ...item, item_data: { ...item.item_data, is_archived: false } });
});

test('unarchiveItem: a Square failure throws', async () => {
  responder = (call) => call.method === 'GET'
    ? jsonResponse({ object: { type: 'ITEM', id: 'ITEM1', version: 1, item_data: {} } })
    : jsonResponse({ errors: [] }, { ok: false, status: 400 });
  await assert.rejects(unarchiveItem('tok', 'ITEM1'), /Failed to unarchive item ITEM1: 400/);
});
