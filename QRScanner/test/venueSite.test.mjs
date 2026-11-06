import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, s3Handlers, resetV2Handlers } from './helpers/testServer.mjs';

// A venue's own web address (VENUE WEB ADDRESS in app.mjs): <name>.<domain>,
// reserved by the venue-sites/<name>/ folder on the shared static site.

const BUCKET = 'env-qrscanner-static-site';
let ctx;
let store;
let corsPuts;

before(async () => {
  ctx = await startTestServer({ clientConfig: { LEGAL_NAME: 'Test Venue LLC' } });
});
after(async () => {
  delete process.env.STATIC_SITE_BUCKET;
  delete process.env.VENUE_SITE_DOMAIN;
  await stopTestServer(ctx);
});

beforeEach(async () => {
  process.env.STATIC_SITE_BUCKET = BUCKET;
  process.env.VENUE_SITE_DOMAIN = 'indietix.net';
  resetV2Handlers();
  // An in-memory static site bucket
  store = new Map();
  corsPuts = [];
  s3Handlers.putObject = async (params) => { store.set(params.Key, params); return { ETag: '"mock"' }; };
  s3Handlers.getObject = async (params) => {
    if (!store.has(params.Key)) throw Object.assign(new Error('The specified key does not exist.'), { code: 'NoSuchKey' });
    return { Body: Buffer.from(store.get(params.Key).Body) };
  };
  s3Handlers.deleteObjects = async (params) => {
    for (const { Key } of params.Delete.Objects) store.delete(Key);
    return { Deleted: params.Delete.Objects };
  };
  s3Handlers.getBucketCors = async () => ({ CORSRules: [{ AllowedHeaders: ['*'], AllowedMethods: ['PUT', 'POST', 'GET'], AllowedOrigins: ['https://example.com', 'http://localhost:3000'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3000 }] });
  s3Handlers.putBucketCors = async (params) => { corsPuts.push(params); return {}; };
  // Start each test without an address
  await ctx.pgClient.query(`UPDATE "Client" SET "configuration" = ("configuration"::jsonb - 'SITE_SUBDOMAIN' || '{"STATIC_WEBSITE_URL": "https://example.com"}'::jsonb)`);
});

const get = (path) => ctx.request('GET', path, { token: ctx.clientToken });
const put = (name) => ctx.request('PUT', '/api/client/site-address', { token: ctx.clientToken, body: { name } });
const siteJson = (name) => JSON.parse(store.get(`venue-sites/${name}/site.json`).Body);
const savedConfig = async () => (await ctx.pgClient.query(`SELECT "configuration" FROM "Client"`)).rows[0].configuration;

test('GET /api/client/site-address: off without VENUE_SITE_DOMAIN or a static bucket', async () => {
  delete process.env.VENUE_SITE_DOMAIN;
  assert.equal((await get('/api/client/site-address')).json.enabled, false);
  process.env.VENUE_SITE_DOMAIN = 'indietix.net';
  delete process.env.STATIC_SITE_BUCKET;
  assert.equal((await get('/api/client/site-address')).json.enabled, false);
  assert.equal((await put('thunderbeaver')).status, 503);
});

test('PUT /api/client/site-address: claims the name, publishes the folder, and points the venue at it', async () => {
  const { status, json } = await put('ThunderBeaver');
  assert.equal(status, 200);
  assert.equal(json.subdomain, 'thunderbeaver');
  assert.equal(json.url, 'https://thunderbeaver.indietix.net');
  assert.deepEqual(siteJson('thunderbeaver'), { clientId: ctx.clientId, venueName: 'Test Venue', logoFile: 'indieTixLogo.png' });
  const privacy = store.get('venue-sites/thunderbeaver/privacy.html');
  assert.equal(privacy.Bucket, BUCKET);
  assert.match(privacy.ContentType, /^text\/html/);
  assert.match(privacy.Body, /Test Venue LLC/);
  assert.ok(store.has('venue-sites/thunderbeaver/terms.html'));
  const config = await savedConfig();
  assert.equal(config.SITE_SUBDOMAIN, 'thunderbeaver');
  assert.equal(config.STATIC_WEBSITE_URL, 'https://thunderbeaver.indietix.net');
  // Poster uploads allowed from the new address, other origins kept
  assert.equal(json.uploadsUpdated, true);
  assert.equal(corsPuts[0].Bucket, `indietix-${ctx.clientId.toLowerCase()}`);
  assert.deepEqual(corsPuts[0].CORSConfiguration.CORSRules[0].AllowedOrigins, ['https://example.com', 'http://localhost:3000', 'https://thunderbeaver.indietix.net']);
  const current = (await get('/api/client/site-address')).json;
  assert.deepEqual(current, { success: true, enabled: true, domain: 'indietix.net', subdomain: 'thunderbeaver', url: 'https://thunderbeaver.indietix.net' });
});

test("PUT /api/client/site-address: refuses a name another venue owns, and doesn't touch its folder", async () => {
  store.set('venue-sites/taken/site.json', { Body: JSON.stringify({ clientId: 'OTHERVENUE' }) });
  const { status, json } = await put('taken');
  assert.equal(status, 409);
  assert.match(json.message, /taken/);
  assert.equal(siteJson('taken').clientId, 'OTHERVENUE');
  assert.equal((await savedConfig()).SITE_SUBDOMAIN, undefined);
  const check = (await get('/api/client/site-address/check?name=taken')).json;
  assert.equal(check.available, false);
});

test('PUT /api/client/site-address: bad and reserved names are refused', async () => {
  for (const name of ['ab', '-thunder', 'thunder-', 'thunder--beaver', 'thunder.beaver', 'thunder beaver', 'a'.repeat(31), '../x', 'www', 'support', 'indietix']) {
    const { status } = await put(name);
    assert.equal(status, 400, name);
  }
  assert.equal(store.size, 0);
  assert.equal((await get('/api/client/site-address/check?name=www')).json.available, false);
});

test('PUT /api/client/site-address: renaming frees the old name and swaps the upload origin', async () => {
  await put('thunderbeaver');
  s3Handlers.getBucketCors = async () => ({ CORSRules: corsPuts.at(-1).CORSConfiguration.CORSRules });
  const { status } = await put('beaverdam');
  assert.equal(status, 200);
  assert.ok(store.has('venue-sites/beaverdam/site.json'));
  assert.ok(![...store.keys()].some(key => key.startsWith('venue-sites/thunderbeaver/')));
  const origins = corsPuts.at(-1).CORSConfiguration.CORSRules[0].AllowedOrigins;
  assert.ok(origins.includes('https://beaverdam.indietix.net'));
  assert.ok(!origins.includes('https://thunderbeaver.indietix.net'));
  assert.ok(origins.includes('https://example.com'));
  // The name it just left is free again
  assert.equal((await get('/api/client/site-address/check?name=thunderbeaver')).json.available, true);
});

test('Client Settings and logo changes re-publish the venue folder', async () => {
  await put('thunderbeaver');
  await ctx.request('PUT', '/api/client', { token: ctx.clientToken, body: { contactName: 'Test', clientEmail: 'test@example.com', configuration: { WEB_HEADER_COMPANY: 'Thunder Beaver Cinema', LEGAL_NAME: 'Thunder Beaver LLC' } } });
  assert.equal(siteJson('thunderbeaver').venueName, 'Thunder Beaver Cinema');
  assert.match(store.get('venue-sites/thunderbeaver/privacy.html').Body, /Thunder Beaver LLC/);
  await ctx.request('DELETE', '/api/client/logo', { token: ctx.clientToken });
  assert.equal(siteJson('thunderbeaver').logoFile, 'indieTixLogo.png');
});

test('GET /api/public/site-address/check: answers availability without logging in', async () => {
  store.set('venue-sites/taken/site.json', { Body: JSON.stringify({ clientId: 'OTHERVENUE' }) });
  assert.equal((await ctx.request('GET', '/api/public/site-address/check?name=taken')).json.available, false);
  assert.equal((await ctx.request('GET', '/api/public/site-address/check?name=thunderbeaver')).json.available, true);
  assert.equal((await ctx.request('GET', '/api/public/site-address/check?name=x')).json.available, false);
  delete process.env.VENUE_SITE_DOMAIN;
  assert.equal((await ctx.request('GET', '/api/public/site-address/check?name=thunderbeaver')).status, 404);
});

test('site address routes are client-login only', async () => {
  assert.equal((await ctx.request('GET', '/api/client/site-address')).status, 401);
  assert.equal((await ctx.request('PUT', '/api/client/site-address', { body: { name: 'thunderbeaver' } })).status, 401);
});
