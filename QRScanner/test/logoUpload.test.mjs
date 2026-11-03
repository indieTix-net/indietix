import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startTestServer, stopTestServer, s3Handlers, resetV2Handlers } from './helpers/testServer.mjs';

// Client Settings' logo upload (VENUE LOGO UPLOAD in app.mjs). Logos go to
// the environment's shared static site, so every key must sit under the
// venue's own venue-logos/<clientId>/ folder.

let ctx;
let puts;
let deletes;

before(async () => {
  ctx = await startTestServer({ clientConfig: { LOGO_FILE: 'indieTixLogo.png' } });
});
after(async () => {
  delete process.env.STATIC_SITE_BUCKET;
  await stopTestServer(ctx);
});

// Each test starts from the default logo (the database persists between tests).
beforeEach(async () => {
  await ctx.request('PUT', '/api/client', { token: ctx.clientToken, body: { contactName: 'Test', clientEmail: 'test@example.com', configuration: { LOGO_FILE: 'indieTixLogo.png' } } });
  process.env.STATIC_SITE_BUCKET = 'env-qrscanner-static-site';
  resetV2Handlers();
  puts = [];
  deletes = [];
  s3Handlers.putObject = async (params) => { puts.push(params); return { ETag: '"mock"' }; };
  s3Handlers.deleteObject = async (params) => { deletes.push(params); return {}; };
});

async function pngDataUrl(width = 1200, height = 400) {
  const buffer = await sharp({ create: { width, height, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

const savedLogo = async () => (await ctx.request('GET', '/api/client', { token: ctx.clientToken })).json.client.configuration.LOGO_FILE;

test('GET /api/client: says whether logo upload is available', async () => {
  assert.equal((await ctx.request('GET', '/api/client', { token: ctx.clientToken })).json.logoUpload, true);
  delete process.env.STATIC_SITE_BUCKET;
  assert.equal((await ctx.request('GET', '/api/client', { token: ctx.clientToken })).json.logoUpload, false);
});

test('POST /api/client/logo: stores a resized PNG under the venue folder and saves LOGO_FILE', async () => {
  const { status, json } = await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: await pngDataUrl() } });
  assert.equal(status, 200);
  assert.match(json.logoFile, new RegExp(`^venue-logos/${ctx.clientId}/logo-[0-9a-f]{16}\\.png$`));
  assert.equal(puts.length, 1);
  assert.equal(puts[0].Bucket, 'env-qrscanner-static-site');
  assert.equal(puts[0].Key, json.logoFile);
  assert.equal(puts[0].ContentType, 'image/png');
  const meta = await sharp(puts[0].Body).metadata();
  assert.equal(meta.format, 'png');
  assert.ok(meta.width <= 600 && meta.height <= 300);
  assert.equal(meta.hasAlpha, true);
  assert.equal(await savedLogo(), json.logoFile);
  // The default logo isn't this venue's upload, so nothing was deleted.
  assert.equal(deletes.length, 0);
});

test("POST /api/client/logo: a new upload deletes the venue's previous one", async () => {
  const first = (await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: await pngDataUrl() } })).json.logoFile;
  const second = (await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: await pngDataUrl(300, 100) } })).json.logoFile;
  assert.notEqual(first, second);
  assert.deepEqual(deletes.map(d => d.Key), [first]);
  assert.equal(await savedLogo(), second);
});

test('POST /api/client/logo: never deletes a file outside the venue folder', async () => {
  await ctx.request('PUT', '/api/client', { token: ctx.clientToken, body: { contactName: 'Test', clientEmail: 'test@example.com', configuration: { LOGO_FILE: 'venue-logos/OTHERVENUE/logo-1.png' } } });
  const { status } = await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: await pngDataUrl() } });
  assert.equal(status, 200);
  assert.equal(deletes.length, 0);
});

test('POST /api/client/logo: SVG and other non-image types are refused', async () => {
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  for (const dataUrl of [svg, 'data:text/html;base64,PGgxPmhpPC9oMT4=', 'not a data url']) {
    const { status } = await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl } });
    assert.equal(status, 400, dataUrl.slice(0, 30));
  }
  assert.equal(puts.length, 0);
});

test('POST /api/client/logo: a file that is not really an image is refused', async () => {
  const { status, json } = await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` } });
  assert.equal(status, 400);
  assert.match(json.message, /could not be read/);
  assert.equal(puts.length, 0);
});

test('POST /api/client/logo: over 4 MB is refused', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
  const { status } = await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: `data:image/png;base64,${big}` } });
  assert.equal(status, 413);
  assert.equal(puts.length, 0);
});

test('POST /api/client/logo: is 503 when this site has no logo bucket', async () => {
  delete process.env.STATIC_SITE_BUCKET;
  const { status } = await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: await pngDataUrl() } });
  assert.equal(status, 503);
  assert.equal(puts.length, 0);
});

test('POST /api/client/logo: a staff login (not the client login) is refused', async () => {
  const user = await ctx.insertUser({ username: 'logo-staff', permissions: { view: true, edit: true, checkIn: true, marketing: true, admin: true } });
  const { status } = await ctx.request('POST', '/api/client/logo', { token: user.token, body: { dataUrl: await pngDataUrl() } });
  assert.equal(status, 403);
  assert.equal(puts.length, 0);
});

test('DELETE /api/client/logo: goes back to the default logo and deletes the upload', async () => {
  const uploaded = (await ctx.request('POST', '/api/client/logo', { token: ctx.clientToken, body: { dataUrl: await pngDataUrl() } })).json.logoFile;
  const { status, json } = await ctx.request('DELETE', '/api/client/logo', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.logoFile, 'indieTixLogo.png');
  assert.equal(await savedLogo(), 'indieTixLogo.png');
  assert.deepEqual(deletes.map(d => d.Key), [uploaded]);
});
