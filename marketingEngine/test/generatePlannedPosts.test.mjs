import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { generatePlannedPosts, __setCurrentClientConfigForTesting } from '../src/index.mjs';

let originalFetch;
let routes;
function route(matcher, responseBody) {
  routes.push({ matcher, responseBody });
}

let dbConfig, containerName, client;

before(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const match = routes.find(r => r.matcher(url, options.method || 'GET', body));
    if (!match) throw new Error(`No mock route matched: ${options.method || 'GET'} ${url} body=${options.body}`);
    return { ok: true, status: 200, json: async () => match.responseBody, text: async () => JSON.stringify(match.responseBody) };
  };

  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'generate_planned_posts_test' }));
  await createDatabaseObjects(dbConfig, 'generate_planned_posts_test', 1, 'Test Theatre', 'TT');
  client = new pg.Client(dbConfig);
  await client.connect();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await client.end();
  await teardownTestDatabase(containerName);
});

beforeEach(async () => {
  routes = [];
  __setCurrentClientConfigForTesting({ SQUARE_ACCESS_TOKEN: 'token-1' });
  await client.query(`DELETE FROM "MarketingPost"`);
  await client.query(`DELETE FROM "MarketingSchedule"`);
});

const FAR_FUTURE_SHOWTIME = 'Sat 12-31-2099 7:00 PM (Main Theatre)';

function qrCodeItem(id) {
  return {
    type: 'ITEM', id,
    custom_attribute_values: { a: { name: 'UseQRCode', type: 'BOOLEAN', boolean_value: true } },
    item_data: { name: 'Digger (2026)', is_archived: false, modifier_list_info: [{ modifier_list_id: `${id}-modlist` }], variations: [], image_ids: [] }
  };
}

function mockCatalogWithOneItem(item) {
  route((url, method, body) => body?.object_types?.includes('CATEGORY'), { objects: [{ type: 'CATEGORY', id: 'cat-cinema', category_data: { name: 'Cinema' } }] });
  route((url, method, body) => body?.object_types?.includes('ITEM'), { objects: [item], related_objects: [] });
  route((url, method) => method === 'GET' && url.includes(`${item.id}-modlist`), {
    object: { modifier_list_data: { modifiers: [{ modifier_data: { name: FAR_FUTURE_SHOWTIME } }] } }
  });
}

test('generatePlannedPosts: an item with no enabled MarketingSchedule generates nothing', async () => {
  mockCatalogWithOneItem(qrCodeItem('item-no-schedule'));
  const inserted = await generatePlannedPosts(client, {});
  assert.equal(inserted, 0);
});

test('generatePlannedPosts: expands an enabled schedule\'s offsets into real MarketingPost draft rows', async () => {
  const item = qrCodeItem('item-with-schedule');
  mockCatalogWithOneItem(item);
  await client.query(
    `INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig", "Enabled")
     VALUES ($1, 'facebook', $2, true)`,
    [item.id, JSON.stringify({ offsets: [{ daysFromAnchor: -28, time: '11:30' }, { daysFromAnchor: -7, time: '11:30' }] })]
  );

  const inserted = await generatePlannedPosts(client, {});
  assert.equal(inserted, 2);

  const rows = await client.query(`SELECT * FROM "MarketingPost" WHERE "SquareItemID" = $1`, [item.id]);
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].Status, 'draft');
  assert.equal(rows.rows[0].Channel, 'facebook');
});

test('generatePlannedPosts: a disabled schedule row is ignored entirely', async () => {
  const item = qrCodeItem('item-disabled-schedule');
  mockCatalogWithOneItem(item);
  await client.query(
    `INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig", "Enabled")
     VALUES ($1, 'facebook', $2, false)`,
    [item.id, JSON.stringify({ offsets: [{ daysFromAnchor: -7, time: '11:30' }] })]
  );

  const inserted = await generatePlannedPosts(client, {});
  assert.equal(inserted, 0);
});

test('generatePlannedPosts: running twice does NOT create duplicate rows (idempotent via the unique slot constraint)', async () => {
  const item = qrCodeItem('item-idempotent');
  mockCatalogWithOneItem(item);
  await client.query(
    `INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig", "Enabled")
     VALUES ($1, 'facebook', $2, true)`,
    [item.id, JSON.stringify({ offsets: [{ daysFromAnchor: -7, time: '11:30' }] })]
  );

  const firstRun = await generatePlannedPosts(client, {});
  const secondRun = await generatePlannedPosts(client, {});

  assert.equal(firstRun, 1);
  assert.equal(secondRun, 0, 'the second run should insert nothing new -- same slot already exists');

  const rows = await client.query(`SELECT * FROM "MarketingPost" WHERE "SquareItemID" = $1`, [item.id]);
  assert.equal(rows.rows.length, 1);
});

test('generatePlannedPosts: an item with no parseable showtimes (no window) is skipped, not an error', async () => {
  const item = qrCodeItem('item-no-window');
  route((url, method, body) => body?.object_types?.includes('CATEGORY'), { objects: [{ type: 'CATEGORY', id: 'cat-cinema', category_data: { name: 'Cinema' } }] });
  route((url, method, body) => body?.object_types?.includes('ITEM'), { objects: [item], related_objects: [] });
  route((url, method) => method === 'GET' && url.includes(`${item.id}-modlist`), { object: { modifier_list_data: { modifiers: [] } } });

  await client.query(
    `INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig", "Enabled")
     VALUES ($1, 'facebook', $2, true)`,
    [item.id, JSON.stringify({ offsets: [{ daysFromAnchor: -7, time: '11:30' }] })]
  );

  const inserted = await generatePlannedPosts(client, {});
  assert.equal(inserted, 0);
});
