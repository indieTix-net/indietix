import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { generateDigestPost, getChicagoNow } from '../src/index.mjs';

const s3Mock = mockClient(S3Client);
let originalFetch;
let dbConfig, containerName, client;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

before(async () => {
  originalFetch = globalThis.fetch;
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'generate_digest_post_test' }));
  await createDatabaseObjects(dbConfig, 'generate_digest_post_test', 1, 'Test Theatre', 'TT');
  client = new pg.Client(dbConfig);
  await client.connect();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await client.end();
  await teardownTestDatabase(containerName);
});

beforeEach(async () => {
  s3Mock.reset();
  await client.query(`DELETE FROM "MarketingPost"`);
});

test('generateDigestPost: DIGEST_ENABLED not true is a no-op regardless of day/time', async () => {
  const inserted = await generateDigestPost(client, { DIGEST_ENABLED: false }, 'client-1');
  assert.equal(inserted, 0);
});

test('generateDigestPost: today not matching DIGEST_DAY_OF_WEEK is a no-op', async () => {
  const now = getChicagoNow();
  const todayIndex = WEEKDAYS.indexOf(now.weekday.toLowerCase());
  const differentDay = WEEKDAYS[(todayIndex + 1) % 7];

  const inserted = await generateDigestPost(client, { DIGEST_ENABLED: true, DIGEST_DAY_OF_WEEK: differentDay }, 'client-1');
  assert.equal(inserted, 0);
});

test('generateDigestPost: right day, but DIGEST_TIME hasn\'t arrived yet, is a no-op', async () => {
  const now = getChicagoNow();
  // A time guaranteed to be in the future relative to "right now," unless
  // this test somehow runs at the literal last minute of the day.
  const futureTime = '23:59';
  if (`${now.hour}:${now.minute}` >= futureTime) {
    // Extremely unlikely, but don't produce a flaky false-pass if it ever is.
    return;
  }

  const inserted = await generateDigestPost(client, {
    DIGEST_ENABLED: true, DIGEST_DAY_OF_WEEK: now.weekday.toLowerCase(), DIGEST_TIME: futureTime
  }, 'client-1');
  assert.equal(inserted, 0);
});

test('generateDigestPost: right day and time already passed -- generates real draft posts with an uploaded image', async () => {
  const now = getChicagoNow();
  s3Mock.on(PutObjectCommand).resolves({});
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.object_types?.includes('CATEGORY')) return { ok: true, json: async () => ({ objects: [] }) };
    if (body?.object_types?.includes('ITEM')) return { ok: true, json: async () => ({ objects: [], related_objects: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };

  const inserted = await generateDigestPost(client, {
    DIGEST_ENABLED: true,
    DIGEST_DAY_OF_WEEK: now.weekday.toLowerCase(),
    DIGEST_TIME: '00:00', // definitely already passed today
    S3_BUCKET_PREFIX: 'indietix-',
    DIGEST_CHANNELS: ['email', 'facebook']
  }, 'testclient');

  assert.equal(inserted, 2, 'one row per configured digest channel');

  const rows = await client.query(`SELECT * FROM "MarketingPost" WHERE "PostType" = 'digest'`);
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].SquareItemID, 'digest', 'the sentinel ID -- a digest is not a real Square item');
  assert.ok(rows.rows[0].PostContent.imageUrl, 'the generated+uploaded image URL should be recorded');

  const s3Call = s3Mock.commandCalls(PutObjectCommand)[0];
  assert.equal(s3Call.args[0].input.Bucket, 'indietix-testclient');
});

test('generateDigestPost: running twice the same day does not duplicate rows (idempotent via the unique slot constraint)', async () => {
  const now = getChicagoNow();
  s3Mock.on(PutObjectCommand).resolves({});
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.object_types?.includes('CATEGORY')) return { ok: true, json: async () => ({ objects: [] }) };
    if (body?.object_types?.includes('ITEM')) return { ok: true, json: async () => ({ objects: [], related_objects: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const config = {
    DIGEST_ENABLED: true, DIGEST_DAY_OF_WEEK: now.weekday.toLowerCase(), DIGEST_TIME: '00:00',
    S3_BUCKET_PREFIX: 'indietix-', DIGEST_CHANNELS: ['email']
  };

  const first = await generateDigestPost(client, config, 'testclient');
  const second = await generateDigestPost(client, config, 'testclient');

  assert.equal(first, 1);
  assert.equal(second, 0, 'same day, same scheduled time -- the slot already exists');
});

// 2026-10-26: optional header/footer text, gated independently per surface
// (drawn into the image vs. prepended/appended to the plain-text caption
// shared by every channel).
test('generateDigestPost: header/footer text is prepended/appended to the caption only when IN_CAPTION is true', async () => {
  const now = getChicagoNow();
  s3Mock.on(PutObjectCommand).resolves({});
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.object_types?.includes('CATEGORY')) return { ok: true, json: async () => ({ objects: [] }) };
    if (body?.object_types?.includes('ITEM')) return { ok: true, json: async () => ({ objects: [], related_objects: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };

  await generateDigestPost(client, {
    DIGEST_ENABLED: true,
    DIGEST_DAY_OF_WEEK: now.weekday.toLowerCase(),
    DIGEST_TIME: '00:00',
    S3_BUCKET_PREFIX: 'indietix-',
    DIGEST_CHANNELS: ['email'],
    DIGEST_HEADER_TEXT: 'Welcome to Liberty Hall',
    DIGEST_HEADER_IN_CAPTION: true,
    DIGEST_FOOTER_TEXT: 'See you there!',
    DIGEST_FOOTER_IN_CAPTION: false // deliberately off -- should NOT appear
  }, 'testclient');

  const rows = await client.query(`SELECT * FROM "MarketingPost" WHERE "PostType" = 'digest'`);
  const caption = rows.rows[0].PostContent.caption;
  assert.match(caption, /^Welcome to Liberty Hall/, 'header text should be prepended since IN_CAPTION is true');
  assert.doesNotMatch(caption, /See you there!/, 'footer text should NOT appear since IN_CAPTION is false');
});

test('generateDigestPost: header/footer text is omitted from the caption entirely when neither IN_CAPTION flag is set', async () => {
  const now = getChicagoNow();
  s3Mock.on(PutObjectCommand).resolves({});
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.object_types?.includes('CATEGORY')) return { ok: true, json: async () => ({ objects: [] }) };
    if (body?.object_types?.includes('ITEM')) return { ok: true, json: async () => ({ objects: [], related_objects: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  };

  await generateDigestPost(client, {
    DIGEST_ENABLED: true,
    DIGEST_DAY_OF_WEEK: now.weekday.toLowerCase(),
    DIGEST_TIME: '00:00',
    S3_BUCKET_PREFIX: 'indietix-',
    DIGEST_CHANNELS: ['email'],
    DIGEST_HEADER_TEXT: 'Welcome to Liberty Hall',
    DIGEST_FOOTER_TEXT: 'See you there!'
    // IN_CAPTION flags intentionally omitted -- text is filled in, but
    // neither surface flag is set, so it shouldn't show up anywhere.
  }, 'testclient');

  const rows = await client.query(`SELECT * FROM "MarketingPost" WHERE "PostType" = 'digest'`);
  const caption = rows.rows[0].PostContent.caption;
  assert.doesNotMatch(caption, /Welcome to Liberty Hall/);
  assert.doesNotMatch(caption, /See you there!/);
});
