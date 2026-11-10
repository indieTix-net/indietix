import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

// The Posts page: paged tabs, show names, and approving many drafts at once.
let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { SQUARE_ACCESS_TOKEN: 'test-square-token' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "MarketingPost"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

// Each post needs its own time slot (item + channel + type + time is unique),
// so the default time moves on a minute per post.
let slot = 0;
async function insertPost({ squareItemId = 'ITEM-A', channel = 'email', status = 'draft', scheduledFor, caption = 'A caption', postType = 'campaign' } = {}) {
  slot += 1;
  scheduledFor = scheduledFor || `2026-05-01 ${String(Math.floor(slot / 60) % 24).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}:00`;
  const result = await ctx.pgClient.query(
    `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status", "PostContent")
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING "ID"`,
    [squareItemId, channel, postType, scheduledFor, status, JSON.stringify({ caption })]
  );
  return result.rows[0].ID;
}

const day = (n) => `2026-06-${String(n).padStart(2, '0')} 11:00:00`;

test('GET /api/marketing/posts: review tab is drafts soonest first, paged, with counts for every tab', async () => {
  for (let n = 1; n <= 30; n++) await insertPost({ scheduledFor: day(n) });
  await insertPost({ status: 'approved' });
  await insertPost({ status: 'sent' });
  await insertPost({ status: 'failed' });
  await insertPost({ status: 'skipped' });

  const first = await ctx.request('GET', '/api/marketing/posts?tab=review&page=1&pageSize=25', { token: ctx.clientToken });
  assert.equal(first.status, 200);
  assert.equal(first.json.total, 30);
  assert.equal(first.json.posts.length, 25);
  assert.match(first.json.posts[0].ScheduledFor, /^2026-06-01/);
  assert.deepEqual(first.json.counts, { review: 30, scheduled: 1, sent: 1, problems: 2 });
  assert.deepEqual(first.json.draftCounts['ITEM-A'], { total: 30, byChannel: { email: 30 } });

  const second = await ctx.request('GET', '/api/marketing/posts?tab=review&page=2&pageSize=25', { token: ctx.clientToken });
  assert.equal(second.json.posts.length, 5);
  assert.match(second.json.posts[4].ScheduledFor, /^2026-06-30/);
});

test('GET /api/marketing/posts: sent and problems tabs are newest first; problems holds failed + skipped', async () => {
  await insertPost({ status: 'sent', scheduledFor: day(1) });
  await insertPost({ status: 'sent', scheduledFor: day(9) });
  await insertPost({ status: 'failed', scheduledFor: day(3) });
  await insertPost({ status: 'skipped', scheduledFor: day(5) });

  const sent = await ctx.request('GET', '/api/marketing/posts?tab=sent', { token: ctx.clientToken });
  assert.deepEqual(sent.json.posts.map(p => p.ScheduledFor.slice(0, 10)), ['2026-06-09', '2026-06-01']);
  const problems = await ctx.request('GET', '/api/marketing/posts?tab=problems', { token: ctx.clientToken });
  assert.deepEqual(problems.json.posts.map(p => p.Status), ['skipped', 'failed']);
  const unknown = await ctx.request('GET', '/api/marketing/posts?tab=nope', { token: ctx.clientToken });
  assert.equal(unknown.json.tab, 'review');
});

test('GET /api/marketing/posts: show, channel, date range and caption search filters', async () => {
  await insertPost({ squareItemId: 'ITEM-A', channel: 'email', scheduledFor: day(1), caption: 'Opening night!' });
  await insertPost({ squareItemId: 'ITEM-A', channel: 'facebook', scheduledFor: day(10), caption: 'Last week to see it' });
  await insertPost({ squareItemId: 'ITEM-B', channel: 'email', scheduledFor: day(10), caption: '100% fun' });

  const get = async (q) => (await ctx.request('GET', `/api/marketing/posts?tab=review&${q}`, { token: ctx.clientToken })).json;
  assert.equal((await get('item=ITEM-A')).total, 2);
  assert.equal((await get('channel=facebook')).total, 1);
  assert.equal((await get('channel=bogus')).total, 3); // an unknown channel is ignored
  assert.equal((await get('from=2026-06-10&to=2026-06-10')).total, 2);
  assert.equal((await get('to=2026-06-01')).total, 1);
  assert.equal((await get('search=opening')).total, 1);
  assert.equal((await get('search=100%25')).total, 1); // % is matched literally, not as a wildcard
  assert.equal((await get('search=%25')).total, 1);
});

test('GET /api/marketing/posts: show names come from Square (archived/deleted too), then tickets, digest labelled', async () => {
  let asked;
  squareHandlers.batchRetrieveCatalog = async (body) => {
    asked = body;
    return { ok: true, status: 200, json: async () => ({ objects: [{ type: 'ITEM', id: 'ITEM-A', is_deleted: true, item_data: { name: 'Old Movie' } }] }) };
  };
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status")
     VALUES ('QR-NAME', '2099-01-01', '2026-06-01 19:00', 'Demo Show', 'LOC', 'Movie', 'Mon 06-01-2026 7:00 PM (Main)', 'ITEM-T', 'valid')`);
  await insertPost({ squareItemId: 'ITEM-A' });
  await insertPost({ squareItemId: 'ITEM-T' });
  await insertPost({ squareItemId: 'ITEM-GONE' });
  await insertPost({ squareItemId: 'digest', postType: 'digest' });

  const { json } = await ctx.request('GET', '/api/marketing/posts?tab=review', { token: ctx.clientToken });
  assert.deepEqual(json.itemNames, { 'ITEM-A': 'Old Movie', 'ITEM-T': 'Demo Show', digest: 'Weekly Digest' });
  assert.equal(asked.include_deleted_objects, true);
  assert.ok(!asked.object_ids.includes('digest'));

  const items = await ctx.request('GET', '/api/marketing/posts/items', { token: ctx.clientToken });
  assert.deepEqual(items.json.items.map(i => i.name), ['Demo Show', 'ITEM-GONE', 'Old Movie', 'Weekly Digest']);
});

test('GET /api/marketing/posts: a Square failure still lists posts (names fall back)', async () => {
  squareHandlers.batchRetrieveCatalog = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await insertPost();
  const { status, json } = await ctx.request('GET', '/api/marketing/posts', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.posts.length, 1);
  assert.deepEqual(json.itemNames, {});
});

test('POST /api/marketing/posts/approve: every draft for one show, leaving other shows and statuses alone', async () => {
  const a1 = await insertPost({ squareItemId: 'ITEM-A', channel: 'email' });
  const a2 = await insertPost({ squareItemId: 'ITEM-A', channel: 'facebook' });
  const aFailed = await insertPost({ squareItemId: 'ITEM-A', status: 'failed' });
  const b1 = await insertPost({ squareItemId: 'ITEM-B' });

  const { status, json } = await ctx.request('POST', '/api/marketing/posts/approve', { token: ctx.clientToken, body: { squareItemId: 'ITEM-A' } });
  assert.equal(status, 200);
  assert.equal(json.approved, 2);
  assert.deepEqual(json.ids.sort(), [a1, a2].sort());
  const rows = await ctx.pgClient.query(`SELECT "ID", "Status" FROM "MarketingPost"`);
  const statusOf = Object.fromEntries(rows.rows.map(r => [r.ID, r.Status]));
  assert.equal(statusOf[aFailed], 'failed');
  assert.equal(statusOf[b1], 'draft');
});

test('POST /api/marketing/posts/approve: chosen posts; non-drafts are skipped, bad input refused', async () => {
  const d1 = await insertPost({ scheduledFor: day(1) });
  const d2 = await insertPost({ scheduledFor: day(2) });
  const sent = await insertPost({ status: 'sent' });
  const { json } = await ctx.request('POST', '/api/marketing/posts/approve', { token: ctx.clientToken, body: { postIds: [d1, sent, d1] } });
  assert.equal(json.approved, 1);
  const left = await ctx.pgClient.query(`SELECT "Status" FROM "MarketingPost" WHERE "ID" = $1`, [d2]);
  assert.equal(left.rows[0].Status, 'draft');

  for (const body of [{}, { postIds: [] }, { postIds: ['x'] }, { postIds: [-1] }, { postIds: Array.from({ length: 501 }, (_, i) => i + 1) }, { squareItemId: '  ' }]) {
    const res = await ctx.request('POST', '/api/marketing/posts/approve', { token: ctx.clientToken, body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
  }
});

test('Posts page routes need the marketing permission, like the Marketing page', async () => {
  await insertPost();
  const door = await ctx.insertUser({ username: 'posts-door', permissions: { view: true, edit: true, checkIn: true, marketing: false, admin: true } });
  const marketer = await ctx.insertUser({ username: 'posts-marketer', permissions: { view: false, edit: false, checkIn: false, marketing: true, admin: false } });
  for (const [method, path, body] of [['GET', '/api/marketing/posts'], ['GET', '/api/marketing/posts/items'], ['POST', '/api/marketing/posts/approve', { squareItemId: 'ITEM-A' }]]) {
    assert.equal((await ctx.request(method, path, { token: door.token, body })).status, 403, path);
    assert.equal((await ctx.request(method, path, { body })).status, 401, path);
  }
  assert.equal((await ctx.request('GET', '/api/marketing/posts', { token: marketer.token })).status, 200);
  assert.equal((await ctx.request('POST', '/api/marketing/posts/approve', { token: marketer.token, body: { squareItemId: 'ITEM-A' } })).json.approved, 1);
});
