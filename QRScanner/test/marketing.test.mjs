import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers, sesHandlers } from './helpers/testServer.mjs';

let ctx;

// A real, minimal 1x1 PNG -- sharp can actually decode it, letting
// normalizePosterImage/normalizeDigestBackgroundImage run for real with no
// network call (dataUrl path only, never url).
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

before(async () => {
  ctx = await startTestServer({ clientConfig: { SQUARE_ACCESS_TOKEN: 'test-square-token', ANTHROPIC_API_KEY: 'test-anthropic-key' } });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  resetSquareHandlers();
  await ctx.pgClient.query(`DELETE FROM "MarketingPost"`);
  await ctx.pgClient.query(`DELETE FROM "MarketingSchedule"`);
  await ctx.pgClient.query(`DELETE FROM "MarketingEmailContact"`);
  // Custom presets and digest settings live in Client.configuration, not a
  // table -- reset them too, or a preset/digest-setting saved by one test
  // leaks into every test after it in this file.
  await ctx.pgClient.query(
    `UPDATE "Client" SET "configuration" = "configuration"::jsonb || '{"MARKETING_SCHEDULE_PRESETS": []}'::jsonb`
  );
});

// ---- /api/marketing/items ----

test('GET /api/marketing/items: lists Square items flagged UseQRCode, with hasSchedule flag', async () => {
  squareHandlers.searchCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [
        { type: 'ITEM', id: 'ITEM-A', item_data: { name: 'Movie A', description: '' }, custom_attribute_values: { attr1: { name: 'UseQRCode', boolean_value: true } } },
        { type: 'ITEM', id: 'ITEM-B', item_data: { name: 'Not QR', description: '' } }
      ]
    })
  });
  await ctx.pgClient.query(`INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig") VALUES ('ITEM-A', 'email', '{"offsets":[]}')`);

  const { status, json } = await ctx.request('GET', '/api/marketing/items', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.equal(json.items[0].squareItemId, 'ITEM-A');
  assert.equal(json.items[0].hasSchedule, true);
});

test('GET /api/marketing/items: Square not configured is a 500', async () => {
  const unconfigured = await startTestServer({ clientId: 'NOSQUAREMKT1', clientConfig: { SQUARE_ACCESS_TOKEN: '' } });
  try {
    const { status } = await unconfigured.request('GET', '/api/marketing/items', { token: unconfigured.clientToken });
    assert.equal(status, 500);
  } finally {
    await stopTestServer(unconfigured);
  }
});

// ---- /api/marketing/items/:squareItemId/window ----

test('GET /api/marketing/items/:squareItemId/window: returns earliest/latest showtime dates', async () => {
  squareHandlers.searchCatalog = async () => ({
    ok: true, status: 200,
    json: async () => ({
      objects: [{ type: 'ITEM', id: 'ITEM-WIN', item_data: { name: 'Windowed', modifier_list_info: [{ modifier_list_id: 'ML1' }] } }],
      related_objects: [{
        type: 'MODIFIER_LIST', id: 'ML1',
        modifier_list_data: { modifiers: [
          { modifier_data: { name: 'Mon 01-05-2026 7:00 PM (Main)' } },
          { modifier_data: { name: 'Fri 01-30-2026 7:00 PM (Main)' } }
        ] }
      }]
    })
  });
  const { status, json } = await ctx.request('GET', '/api/marketing/items/ITEM-WIN/window', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.window.anchorDate, '2026-01-05');
  assert.equal(json.window.lastShowtimeDate, '2026-01-30');
});

test('GET /api/marketing/items/:squareItemId/window: an item with no showtimes returns a null window', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
  const { status, json } = await ctx.request('GET', '/api/marketing/items/ITEM-NONE/window', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.window, null);
});

// ---- schedules CRUD ----

test('PUT /api/marketing/schedules/:squareItemId/:channel: creates a new schedule', async () => {
  const { status } = await ctx.request('PUT', '/api/marketing/schedules/ITEM-SCHED/email', {
    token: ctx.clientToken, body: { phaseConfig: { offsets: [{ daysFromAnchor: -7, time: '09:00' }] } }
  });
  assert.equal(status, 200);
  const row = await ctx.pgClient.query(`SELECT * FROM "MarketingSchedule" WHERE "SquareItemID" = 'ITEM-SCHED'`);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].Enabled, true);
});

test('PUT /api/marketing/schedules/:squareItemId/:channel: upserts on conflict (re-save updates, not duplicates)', async () => {
  await ctx.request('PUT', '/api/marketing/schedules/ITEM-UPSERT/email', { token: ctx.clientToken, body: { phaseConfig: { offsets: [{ daysFromAnchor: -7, time: '09:00' }] } } });
  await ctx.request('PUT', '/api/marketing/schedules/ITEM-UPSERT/email', { token: ctx.clientToken, body: { phaseConfig: { offsets: [{ daysFromAnchor: -3, time: '10:00' }] }, enabled: false } });
  const rows = await ctx.pgClient.query(`SELECT * FROM "MarketingSchedule" WHERE "SquareItemID" = 'ITEM-UPSERT'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].Enabled, false);
});

test('PUT /api/marketing/schedules/:squareItemId/:channel: an invalid channel is rejected with 400', async () => {
  const { status } = await ctx.request('PUT', '/api/marketing/schedules/ITEM-X/not-a-channel', { token: ctx.clientToken, body: { phaseConfig: { offsets: [{ daysFromAnchor: -7, time: '09:00' }] } } });
  assert.equal(status, 400);
});

test('PUT /api/marketing/schedules/:squareItemId/:channel: missing phaseConfig.offsets is rejected with 400', async () => {
  const { status } = await ctx.request('PUT', '/api/marketing/schedules/ITEM-X/email', { token: ctx.clientToken, body: {} });
  assert.equal(status, 400);
});

test('GET /api/marketing/schedules/:squareItemId: lists all channel schedules for an item', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig") VALUES ('ITEM-LIST', 'email', '{"offsets":[]}'), ('ITEM-LIST', 'facebook', '{"offsets":[]}')`);
  const { status, json } = await ctx.request('GET', '/api/marketing/schedules/ITEM-LIST', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.schedules.length, 2);
});

test('DELETE /api/marketing/schedules/:squareItemId/:channel: removes just that channel', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig") VALUES ('ITEM-DEL1', 'email', '{"offsets":[]}'), ('ITEM-DEL1', 'facebook', '{"offsets":[]}')`);
  await ctx.request('DELETE', '/api/marketing/schedules/ITEM-DEL1/email', { token: ctx.clientToken });
  const rows = await ctx.pgClient.query(`SELECT "Channel" FROM "MarketingSchedule" WHERE "SquareItemID" = 'ITEM-DEL1'`);
  assert.deepEqual(rows.rows.map(r => r.Channel), ['facebook']);
});

test('DELETE /api/marketing/schedules/:squareItemId: removes every channel for the item', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig") VALUES ('ITEM-DEL2', 'email', '{"offsets":[]}'), ('ITEM-DEL2', 'facebook', '{"offsets":[]}')`);
  await ctx.request('DELETE', '/api/marketing/schedules/ITEM-DEL2', { token: ctx.clientToken });
  const rows = await ctx.pgClient.query(`SELECT * FROM "MarketingSchedule" WHERE "SquareItemID" = 'ITEM-DEL2'`);
  assert.equal(rows.rows.length, 0);
});

// ---- status ----

async function insertPost({ squareItemId = 'ITEM-POST', channel = 'email', postType = 'campaign', status = 'draft', scheduledFor = '2026-06-01 09:00:00', postContent = {} } = {}) {
  const result = await ctx.pgClient.query(
    `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status", "PostContent")
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING "ID"`,
    [squareItemId, channel, postType, scheduledFor, status, JSON.stringify(postContent)]
  );
  return result.rows[0].ID;
}

test('GET /api/marketing/status: filters by status and squareItemId', async () => {
  await insertPost({ squareItemId: 'ITEM-STATUS-A', status: 'draft', scheduledFor: '2026-06-01 09:00:00' });
  await insertPost({ squareItemId: 'ITEM-STATUS-A', status: 'sent', scheduledFor: '2026-06-02 09:00:00' });
  await insertPost({ squareItemId: 'ITEM-STATUS-B', status: 'draft', scheduledFor: '2026-06-03 09:00:00' });

  const { json } = await ctx.request('GET', '/api/marketing/status?status=draft&squareItemId=ITEM-STATUS-A', { token: ctx.clientToken });
  assert.equal(json.posts.length, 1);
  assert.equal(json.posts[0].SquareItemID, 'ITEM-STATUS-A');
  assert.equal(json.posts[0].Status, 'draft');
});

test('GET /api/marketing/status: limit is capped at 1000', async () => {
  const { status } = await ctx.request('GET', '/api/marketing/status?limit=999999', { token: ctx.clientToken });
  assert.equal(status, 200);
});

// ---- digest settings ----

test('GET /api/marketing/digest-settings: returns configured digest keys and omits unrelated config', async () => {
  await ctx.pgClient.query(
    `UPDATE "Client" SET "configuration" = "configuration"::jsonb || '{"DIGEST_ENABLED": true, "DIGEST_DAY_OF_WEEK": "Monday"}'::jsonb`
  );
  const { status, json } = await ctx.request('GET', '/api/marketing/digest-settings', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.settings.DIGEST_ENABLED, true);
  assert.equal(json.settings.DIGEST_DAY_OF_WEEK, 'Monday');
  assert.equal('SQUARE_ACCESS_TOKEN' in json.settings, false, 'only the whitelisted DIGEST_* keys should be present');
});

test('PUT /api/marketing/digest-settings: updates recognized keys and uploads a background image', async () => {
  const { status, json } = await ctx.request('PUT', '/api/marketing/digest-settings', {
    token: ctx.clientToken, body: { DIGEST_ENABLED: true, DIGEST_DAY_OF_WEEK: 'Monday', backgroundImageDataUrl: TINY_PNG_DATA_URL }
  });
  assert.equal(status, 200);
  assert.ok(json.backgroundImageUrl);

  const check = await ctx.request('GET', '/api/marketing/digest-settings', { token: ctx.clientToken });
  assert.equal(check.json.settings.DIGEST_ENABLED, true);
  assert.equal(check.json.settings.DIGEST_BACKGROUND_IMAGE_URL, json.backgroundImageUrl);
});

test('PUT /api/marketing/digest-settings: updates per-field font size/bold and header/footer text+flags', async () => {
  const { status } = await ctx.request('PUT', '/api/marketing/digest-settings', {
    token: ctx.clientToken,
    body: {
      DIGEST_DATE_FONT_SIZE: 30, DIGEST_DATE_BOLD: 'true',
      DIGEST_EVENT_FONT_SIZE: 20, DIGEST_EVENT_BOLD: 'false',
      DIGEST_TIME_FONT_SIZE: 10, DIGEST_TIME_BOLD: 'true',
      DIGEST_HEADER_TEXT: 'Welcome to Liberty Hall', DIGEST_HEADER_FONT_SIZE: 24,
      DIGEST_HEADER_BOLD: 'true', DIGEST_HEADER_IN_IMAGE: 'true', DIGEST_HEADER_IN_CAPTION: 'false',
      DIGEST_FOOTER_TEXT: 'See you there!', DIGEST_FOOTER_FONT_SIZE: 12,
      DIGEST_FOOTER_BOLD: 'false', DIGEST_FOOTER_IN_IMAGE: 'false', DIGEST_FOOTER_IN_CAPTION: 'true'
    }
  });
  assert.equal(status, 200);

  const check = await ctx.request('GET', '/api/marketing/digest-settings', { token: ctx.clientToken });
  const s = check.json.settings;
  assert.equal(s.DIGEST_DATE_FONT_SIZE, 30);
  assert.equal(s.DIGEST_EVENT_BOLD, 'false');
  assert.equal(s.DIGEST_TIME_FONT_SIZE, 10);
  assert.equal(s.DIGEST_HEADER_TEXT, 'Welcome to Liberty Hall');
  assert.equal(s.DIGEST_HEADER_IN_IMAGE, 'true');
  assert.equal(s.DIGEST_HEADER_IN_CAPTION, 'false');
  assert.equal(s.DIGEST_FOOTER_TEXT, 'See you there!');
  assert.equal(s.DIGEST_FOOTER_IN_CAPTION, 'true');
});

test('PUT /api/marketing/digest-settings: no recognized fields is a 400', async () => {
  const { status } = await ctx.request('PUT', '/api/marketing/digest-settings', { token: ctx.clientToken, body: { NOT_A_REAL_KEY: 'x' } });
  assert.equal(status, 400);
});

// ---- custom presets ----

test('POST + GET /api/marketing/custom-presets: creates and lists a preset', async () => {
  const post = await ctx.request('POST', '/api/marketing/custom-presets', {
    token: ctx.clientToken, body: { name: 'My Preset', offsets: [{ daysFromAnchor: -14, time: '09:00' }] }
  });
  assert.equal(post.status, 200);
  const get = await ctx.request('GET', '/api/marketing/custom-presets', { token: ctx.clientToken });
  assert.equal(get.json.presets.length, 1);
  assert.equal(get.json.presets[0].name, 'My Preset');
});

test('POST /api/marketing/custom-presets: re-saving the same name (case-insensitive) overwrites, not duplicates', async () => {
  await ctx.request('POST', '/api/marketing/custom-presets', { token: ctx.clientToken, body: { name: 'Dup', offsets: [{ daysFromAnchor: -1, time: '09:00' }] } });
  await ctx.request('POST', '/api/marketing/custom-presets', { token: ctx.clientToken, body: { name: 'DUP', offsets: [{ daysFromAnchor: -2, time: '10:00' }] } });
  const get = await ctx.request('GET', '/api/marketing/custom-presets', { token: ctx.clientToken });
  assert.equal(get.json.presets.length, 1);
  assert.equal(get.json.presets[0].offsets[0].daysFromAnchor, -2);
});

test('POST /api/marketing/custom-presets: invalid offsets shape is rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/marketing/custom-presets', { token: ctx.clientToken, body: { name: 'Bad', offsets: [{ daysFromAnchor: 'not-a-number', time: '09:00' }] } });
  assert.equal(status, 400);
});

test('DELETE /api/marketing/custom-presets: removes by name query param', async () => {
  await ctx.request('POST', '/api/marketing/custom-presets', { token: ctx.clientToken, body: { name: 'ToDelete', offsets: [{ daysFromAnchor: -1, time: '09:00' }] } });
  const del = await ctx.request('DELETE', '/api/marketing/custom-presets?name=ToDelete', { token: ctx.clientToken });
  assert.equal(del.status, 200);
  const get = await ctx.request('GET', '/api/marketing/custom-presets', { token: ctx.clientToken });
  assert.equal(get.json.presets.length, 0);
});

test('DELETE /api/marketing/custom-presets: missing name query param is a 400', async () => {
  const { status } = await ctx.request('DELETE', '/api/marketing/custom-presets', { token: ctx.clientToken });
  assert.equal(status, 400);
});

// ---- regenerate-caption (Anthropic) ----

test('POST /api/marketing/posts/:postId/regenerate-caption: regenerates a draft campaign post caption', async () => {
  const postId = await insertPost({ status: 'draft', postType: 'campaign' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === 'https://api.anthropic.com/v1/messages') {
      return { ok: true, status: 200, json: async () => ({ content: [{ text: 'A fresh new caption.' }] }) };
    }
    if (url.startsWith('https://connect.squareup.com/v2/catalog/object/')) {
      return { ok: true, status: 200, json: async () => ({ object: { item_data: { name: 'Test Item' } } }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, json } = await ctx.request('POST', `/api/marketing/posts/${postId}/regenerate-caption`, { token: ctx.clientToken });
    assert.equal(status, 200);
    assert.equal(json.caption, 'A fresh new caption.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/marketing/posts/:postId/regenerate-caption: a non-draft post is rejected with 400', async () => {
  const postId = await insertPost({ status: 'approved' });
  const { status } = await ctx.request('POST', `/api/marketing/posts/${postId}/regenerate-caption`, { token: ctx.clientToken });
  assert.equal(status, 400);
});

test('POST /api/marketing/posts/:postId/regenerate-caption: a digest post is rejected with 400', async () => {
  const postId = await insertPost({ status: 'draft', postType: 'digest' });
  const { status, json } = await ctx.request('POST', `/api/marketing/posts/${postId}/regenerate-caption`, { token: ctx.clientToken });
  assert.equal(status, 400);
  assert.match(json.message, /digest/);
});

test('POST /api/marketing/posts/:postId/regenerate-caption: missing ANTHROPIC_API_KEY is a 400', async () => {
  const noKeyCtx = await startTestServer({ clientId: 'NOANTHROPICKEY1', clientConfig: { SQUARE_ACCESS_TOKEN: 'x', ANTHROPIC_API_KEY: '' } });
  try {
    const postId = await (async () => {
      const r = await noKeyCtx.pgClient.query(
        `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status") VALUES ('X', 'email', 'campaign', NOW(), 'draft') RETURNING "ID"`
      );
      return r.rows[0].ID;
    })();
    const { status, json } = await noKeyCtx.request('POST', `/api/marketing/posts/${postId}/regenerate-caption`, { token: noKeyCtx.clientToken });
    assert.equal(status, 400);
    assert.match(json.message, /ANTHROPIC_API_KEY/);
  } finally {
    await stopTestServer(noKeyCtx);
  }
});

test('POST /api/marketing/posts/:postId/regenerate-caption: a nonexistent post returns 404', async () => {
  const { status } = await ctx.request('POST', '/api/marketing/posts/999999/regenerate-caption', { token: ctx.clientToken });
  assert.equal(status, 404);
});

// ---- post edit/delete/approve/send-now ----

test('PUT /api/marketing/posts/:postId: edits the caption and uploads a new image', async () => {
  const postId = await insertPost({ status: 'draft', postContent: { caption: 'old' } });
  const { status, json } = await ctx.request('PUT', `/api/marketing/posts/${postId}`, {
    token: ctx.clientToken, body: { caption: 'new caption', imageDataUrl: TINY_PNG_DATA_URL }
  });
  assert.equal(status, 200);
  assert.equal(json.postContent.caption, 'new caption');
  assert.ok(json.postContent.imageUrl);
});

test('PUT /api/marketing/posts/:postId: a sent post cannot be edited', async () => {
  const postId = await insertPost({ status: 'sent' });
  const { status } = await ctx.request('PUT', `/api/marketing/posts/${postId}`, { token: ctx.clientToken, body: { caption: 'x' } });
  assert.equal(status, 400);
});

test('DELETE /api/marketing/posts/:postId: deletes a draft post', async () => {
  const postId = await insertPost({ status: 'draft' });
  const { status } = await ctx.request('DELETE', `/api/marketing/posts/${postId}`, { token: ctx.clientToken });
  assert.equal(status, 200);
  const row = await ctx.pgClient.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [postId]);
  assert.equal(row.rows.length, 0);
});

test('DELETE /api/marketing/posts/:postId: a sent post cannot be deleted (kept as history)', async () => {
  const postId = await insertPost({ status: 'sent' });
  const { status, json } = await ctx.request('DELETE', `/api/marketing/posts/${postId}`, { token: ctx.clientToken });
  assert.equal(status, 400);
  assert.match(json.message, /history/);
});

test('PUT /api/marketing/posts/:postId/approve: moves a draft to approved', async () => {
  const postId = await insertPost({ status: 'draft' });
  const { status } = await ctx.request('PUT', `/api/marketing/posts/${postId}/approve`, { token: ctx.clientToken });
  assert.equal(status, 200);
  const row = await ctx.pgClient.query(`SELECT "Status" FROM "MarketingPost" WHERE "ID" = $1`, [postId]);
  assert.equal(row.rows[0].Status, 'approved');
});

test('PUT /api/marketing/posts/:postId/approve: a non-draft post is rejected with 400', async () => {
  const postId = await insertPost({ status: 'approved' });
  const { status } = await ctx.request('PUT', `/api/marketing/posts/${postId}/approve`, { token: ctx.clientToken });
  assert.equal(status, 400);
});

test('POST /api/marketing/posts/:postId/send-now: sends an approved email campaign post to every active contact', async () => {
  const postId = await insertPost({ status: 'approved', channel: 'email', postContent: { caption: 'Come see it!' } });
  await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('contact1@example.com', 'active', 'tok1'), ('contact2@example.com', 'active', 'tok2')`);
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('https://connect.squareup.com/v2/catalog/object/')) {
      return { ok: true, status: 200, json: async () => ({ object: { id: 'ITEM-POST', item_data: { name: 'Test Movie' } } }) };
    }
    return originalFetch(url, opts);
  };
  let emailsSent = [];
  sesHandlers.sendRawEmail = async (params) => { emailsSent.push(params); return { MessageId: 'mock-id' }; };
  try {
    const { status, json } = await ctx.request('POST', `/api/marketing/posts/${postId}/send-now`, { token: ctx.clientToken });
    assert.equal(status, 200);
    assert.equal(json.sent, 2);
    assert.equal(json.failed, 0);
    assert.equal(emailsSent.length, 2);
    const row = await ctx.pgClient.query(`SELECT "Status" FROM "MarketingPost" WHERE "ID" = $1`, [postId]);
    assert.equal(row.rows[0].Status, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/marketing/posts/:postId/send-now: a non-email channel is rejected (not built yet)', async () => {
  const postId = await insertPost({ status: 'approved', channel: 'facebook' });
  const { status, json } = await ctx.request('POST', `/api/marketing/posts/${postId}/send-now`, { token: ctx.clientToken });
  assert.equal(status, 400);
  assert.match(json.message, /isn't built yet/);
});

test('POST /api/marketing/posts/:postId/send-now: a non-approved post is rejected with 400', async () => {
  const postId = await insertPost({ status: 'draft', channel: 'email' });
  const { status } = await ctx.request('POST', `/api/marketing/posts/${postId}/send-now`, { token: ctx.clientToken });
  assert.equal(status, 400);
});

test('POST /api/marketing/posts/:postId/send-now: no active email contacts is rejected with 400', async () => {
  const postId = await insertPost({ status: 'approved', channel: 'email' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('https://connect.squareup.com/v2/catalog/object/')) {
      return { ok: true, status: 200, json: async () => ({ object: { id: 'ITEM-POST', item_data: { name: 'Test Movie' } } }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, json } = await ctx.request('POST', `/api/marketing/posts/${postId}/send-now`, { token: ctx.clientToken });
    assert.equal(status, 400);
    assert.match(json.message, /No active email contacts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/marketing/posts/:postId/send-now: a deleted/archived Square item marks the post skipped', async () => {
  const postId = await insertPost({ status: 'approved', channel: 'email' });
  await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('x@example.com', 'active', 'tokx')`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.startsWith('https://connect.squareup.com/v2/catalog/object/')) {
      return { ok: true, status: 200, json: async () => ({ object: { id: 'ITEM-POST', is_deleted: true } }) };
    }
    return originalFetch(url, opts);
  };
  try {
    const { status, json } = await ctx.request('POST', `/api/marketing/posts/${postId}/send-now`, { token: ctx.clientToken });
    assert.equal(status, 400);
    assert.match(json.message, /no longer active/);
    const row = await ctx.pgClient.query(`SELECT "Status" FROM "MarketingPost" WHERE "ID" = $1`, [postId]);
    assert.equal(row.rows[0].Status, 'skipped');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---- email contacts (admin) ----

test('GET /api/marketing/email-contacts: lists contacts newest first', async () => {
  await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('a@example.com', 'active', 'tok-a')`);
  const { status, json } = await ctx.request('GET', '/api/marketing/email-contacts', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.contacts.length, 1);
});

test('POST /api/marketing/email-contacts: adds a new contact', async () => {
  const { status, json } = await ctx.request('POST', '/api/marketing/email-contacts', { token: ctx.clientToken, body: { email: 'New@Example.com' } });
  assert.equal(status, 200);
  assert.equal(json.contact.Email, 'new@example.com');
});

test('POST /api/marketing/email-contacts: an invalid email is rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/marketing/email-contacts', { token: ctx.clientToken, body: { email: 'nope' } });
  assert.equal(status, 400);
});

test('PUT /api/marketing/email-contacts/:id/status: toggles status', async () => {
  const insert = await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('tog@example.com', 'active', 'tok-tog') RETURNING "ID"`);
  const { status } = await ctx.request('PUT', `/api/marketing/email-contacts/${insert.rows[0].ID}/status`, { token: ctx.clientToken, body: { status: 'unsubscribed' } });
  assert.equal(status, 200);
});

test('PUT /api/marketing/email-contacts/:id/status: an invalid status value is rejected with 400', async () => {
  const { status } = await ctx.request('PUT', '/api/marketing/email-contacts/1/status', { token: ctx.clientToken, body: { status: 'not-a-status' } });
  assert.equal(status, 400);
});

test('DELETE /api/marketing/email-contacts/:id: removes a contact', async () => {
  const insert = await ctx.pgClient.query(`INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('del@example.com', 'active', 'tok-del') RETURNING "ID"`);
  const { status } = await ctx.request('DELETE', `/api/marketing/email-contacts/${insert.rows[0].ID}`, { token: ctx.clientToken });
  assert.equal(status, 200);
  const row = await ctx.pgClient.query(`SELECT * FROM "MarketingEmailContact" WHERE "ID" = $1`, [insert.rows[0].ID]);
  assert.equal(row.rows.length, 0);
});
