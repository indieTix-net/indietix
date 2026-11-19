import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  squareApiBase,
  retrieveCatalogObject,
  deleteCatalogObject,
  upsertCatalogObject,
  archiveItem
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
    const call = { url: String(url), method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined };
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

test('archiveItem: re-reads the item, then saves it back at that version with is_archived true', async () => {
  responder = (call) => call.method === 'GET'
    ? jsonResponse({ object: { id: 'ITEM1', version: 42, item_data: { name: 'The Glass Orchard', is_archived: false } } })
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
    item_data: { name: 'The Glass Orchard', is_archived: true }
  });
});

test('archiveItem: throws if Square returns no object to archive', async () => {
  responder = () => jsonResponse({});
  await assert.rejects(archiveItem('tok', 'ITEM1'), /Could not retrieve item ITEM1 for archiving/);
  assert.equal(calls.length, 1);
});
