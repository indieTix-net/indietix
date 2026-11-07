import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { resolveMetaPageToken, sendFacebookPost, fitImageForInstagram, sendInstagramPost, __setCurrentClientConfigForTesting } from '../src/index.mjs';

const s3Mock = mockClient(S3Client);
const originalFetch = globalThis.fetch;
const META = { META_PAGE_ACCESS_TOKEN: 'system-user-token', META_PAGE_ID: 'page-123', META_IG_BUSINESS_ID: 'ig-456', S3_BUCKET_PREFIX: 'indietix-' };

const image = (width, height, format = 'jpeg') =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })[format]().toBuffer();
const jsonResponse = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });

beforeEach(() => {
  s3Mock.reset();
  __setCurrentClientConfigForTesting({ ...META });
});
after(() => { globalThis.fetch = originalFetch; });

test('resolveMetaPageToken: swaps a system-user token for the Page token', async () => {
  globalThis.fetch = async (url) => {
    assert.match(url, /\/page-123\?fields=access_token&access_token=system-user-token/);
    return jsonResponse({ access_token: 'page-token', id: 'page-123' });
  };
  assert.equal(await resolveMetaPageToken(), 'page-token');
});

test('resolveMetaPageToken: falls back to the stored token when the lookup fails', async () => {
  globalThis.fetch = async () => jsonResponse({ error: { message: 'nope' } }, false);
  assert.equal(await resolveMetaPageToken(), 'system-user-token');
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal(await resolveMetaPageToken(), 'system-user-token');
});

test('sendFacebookPost: posts the photo with the Page token, not the stored one', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options?.body ? Object.fromEntries(options.body) : null });
    if (/fields=access_token/.test(url)) return jsonResponse({ access_token: 'page-token' });
    return jsonResponse({ id: 'photo-1', post_id: 'page-123_post-1' });
  };
  const result = await sendFacebookPost({ PostContent: { caption: 'Tonight!', imageUrl: 'https://img.example/poster.jpg' } });
  assert.equal(result.platformPostId, 'page-123_post-1');
  const post = calls.find(c => /\/photos$/.test(c.url));
  assert.equal(post.body.access_token, 'page-token');
  assert.equal(post.body.url, 'https://img.example/poster.jpg');
  assert.equal(post.body.caption, 'Tonight!');
});

test('fitImageForInstagram: a 2:3 poster becomes a 1080x1350 JPEG (4:5)', async () => {
  const out = await fitImageForInstagram(await image(800, 1200));
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1080, 1350]);
});

test('fitImageForInstagram: a very wide image becomes 1.91:1', async () => {
  const meta = await sharp(await fitImageForInstagram(await image(3000, 1000))).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 565]);
});

test('fitImageForInstagram: an in-range JPEG is left alone; an in-range PNG is converted, same shape', async () => {
  assert.equal(await fitImageForInstagram(await image(1000, 1000)), null);
  const meta = await sharp(await fitImageForInstagram(await image(1000, 1000, 'png'))).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1080, 1080]);
});

test('sendInstagramPost: a poster is fitted, uploaded publicly and published from the fitted copy', async () => {
  s3Mock.on(PutObjectCommand).resolves({});
  const poster = await image(800, 1200);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options?.body ? Object.fromEntries(options.body) : null });
    if (url === 'https://img.example/poster.jpg') return { ok: true, arrayBuffer: async () => poster };
    if (/\/ig-456\/media$/.test(url)) return jsonResponse({ id: 'container-1' });
    if (/container-1\?fields=status_code/.test(url)) return jsonResponse({ status_code: 'FINISHED' });
    if (/media_publish$/.test(url)) return jsonResponse({ id: 'ig-media-1' });
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await sendInstagramPost({ ID: 42, PostContent: { caption: 'Tonight!', imageUrl: 'https://img.example/poster.jpg' } }, 'M5E5N7KAHZA7Q');

  assert.equal(result.platformPostId, 'ig-media-1');
  const upload = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  assert.equal(upload.Bucket, 'indietix-m5e5n7kahza7q');
  assert.match(upload.Key, /^digest-generated\/instagram_42_\d+\.jpg$/);
  const container = calls.find(c => /\/ig-456\/media$/.test(c.url));
  assert.equal(container.body.image_url, `https://indietix-m5e5n7kahza7q.s3.us-east-2.amazonaws.com/${upload.Key}`);
  assert.equal(result.instagramImageUrl, container.body.image_url);
});

test('sendInstagramPost: an image already in range is published as-is, nothing uploaded', async () => {
  const square = await image(1000, 1000);
  let containerImage;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://img.example/square.jpg') return { ok: true, arrayBuffer: async () => square };
    if (/\/media$/.test(url)) { containerImage = Object.fromEntries(options.body).image_url; return jsonResponse({ id: 'c-2' }); }
    if (/fields=status_code/.test(url)) return jsonResponse({ status_code: 'FINISHED' });
    return jsonResponse({ id: 'ig-media-2' });
  };
  await sendInstagramPost({ ID: 43, PostContent: { caption: 'x', imageUrl: 'https://img.example/square.jpg' } }, 'M5E5N7KAHZA7Q');
  assert.equal(containerImage, 'https://img.example/square.jpg');
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
});
