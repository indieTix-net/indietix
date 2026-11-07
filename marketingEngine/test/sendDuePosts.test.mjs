import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { sendDuePost, sendDuePosts, sendEmailPost, __setCurrentClientConfigForTesting } from '../src/index.mjs';

const sesMock = mockClient(SESClient);
let originalFetch;
let dbConfig, containerName, client;

before(async () => {
  originalFetch = globalThis.fetch;
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'send_due_posts_test' }));
  await createDatabaseObjects(dbConfig, 'send_due_posts_test', 1, 'Test Theatre', 'TT');
  client = new pg.Client(dbConfig);
  await client.connect();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await client.end();
  await teardownTestDatabase(containerName);
});

beforeEach(async () => {
  sesMock.reset();
  __setCurrentClientConfigForTesting({ WEB_HEADER_COMPANY: 'Test Venue', SENDER_EMAIL: 'noreply@example.com', STATIC_WEBSITE_URL: 'https://example.com' });
  // sendDuePosts-level tests select ALL approved+due rows in the table --
  // without clearing between tests, an earlier test's row (several of
  // which call sendEmailPost directly and never transition Status away
  // from 'approved') would leak into a later test's assertions about
  // exactly what got processed.
  await client.query(`DELETE FROM "MarketingPost"`);
});

let postCounter = 0;
async function insertPost({ channel = 'facebook', postType = 'campaign', status = 'approved', squareItemId }) {
  postCounter += 1;
  const id = squareItemId || `item-${postCounter}`;
  const result = await client.query(
    `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status", "PostContent")
     VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'America/Chicago') - interval '1 minute', $4, $5) RETURNING *`,
    [id, channel, postType, status, JSON.stringify({ caption: 'Come see our movie!', imageUrl: null })]
  );
  return result.rows[0];
}

test('sendDuePost: a channel with no credentials configured falls back to the dry-run stub and is still marked sent', async () => {
  __setCurrentClientConfigForTesting({}); // no META_* credentials at all
  const post = await insertPost({ channel: 'facebook' });

  await sendDuePost(client, post, null, 'send_due_posts_test');

  const row = await client.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [post.ID]);
  assert.equal(row.rows[0].Status, 'sent');
  assert.ok(row.rows[0].PostContent.dryRun, 'should be flagged as a dry run, not a real send');
});

test('sendDuePost: facebook WITH credentials configured calls the real sender and records the platform post ID', async () => {
  __setCurrentClientConfigForTesting({ META_PAGE_ACCESS_TOKEN: 'fb-token', META_PAGE_ID: 'page-123' });
  globalThis.fetch = async (url) => {
    if (/fields=access_token/.test(url)) return { ok: true, json: async () => ({ access_token: 'page-token', id: 'page-123' }) };
    assert.match(url, /\/page-123\/feed/); // no imageUrl on this post -> /feed, not /photos
    return { ok: true, json: async () => ({ id: 'fb-post-999' }) };
  };
  const post = await insertPost({ channel: 'facebook' });

  await sendDuePost(client, post, null, 'send_due_posts_test');

  const row = await client.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [post.ID]);
  assert.equal(row.rows[0].Status, 'sent');
  assert.equal(row.rows[0].PlatformPostID, 'fb-post-999');
  assert.equal(row.rows[0].PostContent.dryRun, undefined);
});

test('sendDuePost: a sender throwing marks the post failed with the error message captured', async () => {
  __setCurrentClientConfigForTesting({ META_PAGE_ACCESS_TOKEN: 'fb-token', META_PAGE_ID: 'page-123' });
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) });
  const post = await insertPost({ channel: 'facebook' });

  await sendDuePost(client, post, null, 'send_due_posts_test');

  const row = await client.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [post.ID]);
  assert.equal(row.rows[0].Status, 'failed');
  assert.match(row.rows[0].FailureReason, /Invalid OAuth access token/);
});

test('sendEmailPost: partial failure across recipients still counts as an overall successful send', async () => {
  await client.query(`DELETE FROM "MarketingEmailContact"`);
  await client.query(
    `INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES
      ('good@example.com', 'active', 'tok-aaaaaaaaaaaaaaaaaaaaaaaa'),
      ('bad@example.com', 'active', 'tok-bbbbbbbbbbbbbbbbbbbbbbbb')`
  );
  let callCount = 0;
  sesMock.on(SendRawEmailCommand).callsFake(() => {
    callCount += 1;
    if (callCount === 1) throw new Error('SES throttled');
    return { MessageId: 'msg-1' };
  });

  const post = await insertPost({ channel: 'email' });
  const result = await sendEmailPost(client, post, { item_data: { name: 'Movie' } }, 'send_due_posts_test');

  assert.equal(result.recipientCount, 1);
  assert.equal(result.failedRecipients.length, 1);
});

test('sendEmailPost: ALL recipients failing throws rather than silently "succeeding"', async () => {
  await client.query(`DELETE FROM "MarketingEmailContact"`);
  await client.query(
    `INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken") VALUES ('only@example.com', 'active', 'tok-cccccccccccccccccccccccc')`
  );
  sesMock.on(SendRawEmailCommand).rejects(new Error('SES down'));

  const post = await insertPost({ channel: 'email' });
  await assert.rejects(() => sendEmailPost(client, post, { item_data: { name: 'Movie' } }, 'send_due_posts_test'), /All 1 email send\(s\) failed/);
});

test('sendEmailPost: zero active email contacts throws clearly rather than silently sending to nobody', async () => {
  await client.query(`DELETE FROM "MarketingEmailContact"`);
  const post = await insertPost({ channel: 'email' });
  await assert.rejects(() => sendEmailPost(client, post, { item_data: { name: 'Movie' } }, 'send_due_posts_test'), /No active email contacts/);
});

test('sendDuePosts: a stale/archived source item is marked skipped, not sent, and never reaches the channel sender', async () => {
  __setCurrentClientConfigForTesting({});
  const post = await insertPost({ channel: 'facebook', squareItemId: 'archived-item-1' });
  globalThis.fetch = async (url) => {
    assert.match(url, /archived-item-1/);
    return { ok: true, json: async () => ({ object: { id: 'archived-item-1', item_data: { is_archived: true } } }) };
  };

  const { sent, skipped } = await sendDuePosts(client, 'send_due_posts_test');

  assert.equal(skipped, 1);
  assert.equal(sent, 0);
  const row = await client.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [post.ID]);
  assert.equal(row.rows[0].Status, 'skipped');
});

test('sendDuePosts: a digest post skips the pre-send Square check entirely (no item to check)', async () => {
  __setCurrentClientConfigForTesting({});
  await insertPost({ channel: 'email', postType: 'digest', squareItemId: 'digest' });
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ object: {} }) }; };

  // No email contacts seeded -- sendEmailPost will throw, which sendDuePost
  // catches and marks failed, but the point of this test is specifically
  // that retrieveCatalogObject was never called for a digest post.
  await client.query(`DELETE FROM "MarketingEmailContact"`);
  await sendDuePosts(client, 'send_due_posts_test');

  assert.equal(fetchCalled, false, 'a digest post is not a real Square item -- there is nothing to pre-check');
});

test('sendDuePosts: a post due later today in Chicago is not sent early', async () => {
  __setCurrentClientConfigForTesting({});
  await client.query(
    `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status", "PostContent")
     VALUES ('digest', 'facebook', 'digest', (NOW() AT TIME ZONE 'America/Chicago') + interval '2 hours', 'approved', '{}')`
  );
  const result = await sendDuePosts(client, 'send_due_posts_test');
  assert.equal(result.sent, 0);
});
