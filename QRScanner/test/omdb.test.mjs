import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, omdbCalls, setOmdbHandler, resetOmdb } from './helpers/testServer.mjs';

let ctx;
let noKeyCtx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { OMDB_API_KEY: 'venue-omdb-key' } });
  noKeyCtx = await startTestServer({ clientId: 'NOOMDBCLIENT', clientConfig: { OMDB_API_KEY: '' } });
});
after(async () => {
  await stopTestServer(ctx);
  await stopTestServer(noKeyCtx);
});
beforeEach(() => resetOmdb());

const jsonResponse = (body) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body });

test('GET /api/omdb/search: uses the venue key server-side and passes results through', async () => {
  setOmdbHandler(async () => jsonResponse({ Response: 'True', Search: [{ Title: 'Jaws', imdbID: 'tt0073195', Year: '1975' }] }));
  const { status, json } = await ctx.request('GET', '/api/omdb/search?title=Jaws&year=1975', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.Search[0].imdbID, 'tt0073195');
  const called = new URL(omdbCalls[0]);
  assert.equal(called.searchParams.get('apikey'), 'venue-omdb-key');
  assert.equal(called.searchParams.get('s'), 'Jaws');
  assert.equal(called.searchParams.get('y'), '1975');
});

test('GET /api/omdb/movie/:imdbID: fetches full details with the venue key', async () => {
  setOmdbHandler(async () => jsonResponse({ Response: 'True', Title: 'Jaws', Plot: 'A shark.' }));
  const { status, json } = await ctx.request('GET', '/api/omdb/movie/tt0073195', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.Title, 'Jaws');
  const called = new URL(omdbCalls[0]);
  assert.equal(called.searchParams.get('i'), 'tt0073195');
  assert.equal(called.searchParams.get('apikey'), 'venue-omdb-key');
});

test('GET /api/omdb/movie/:imdbID: rejects a malformed id without calling OMDB', async () => {
  const { status } = await ctx.request('GET', '/api/omdb/movie/not-an-id', { token: ctx.clientToken });
  assert.equal(status, 400);
  assert.equal(omdbCalls.length, 0);
});

test('GET /api/omdb/poster/:imdbID: returns the poster as base64', async () => {
  setOmdbHandler(async () => ({
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer
  }));
  const { status, json } = await ctx.request('GET', '/api/omdb/poster/tt0073195', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.contentType, 'image/jpeg');
  assert.equal(json.data, Buffer.from([0xff, 0xd8, 0xff]).toString('base64'));
  assert.ok(omdbCalls[0].startsWith('https://img.omdbapi.com/'));
});

test('OMDB routes: a venue with no key gets a clear 400 and OMDB is never called', async () => {
  const { status, json } = await noKeyCtx.request('GET', '/api/omdb/search?title=Jaws', { token: noKeyCtx.clientToken });
  assert.equal(status, 400);
  assert.match(json.Error, /OMDB_API_KEY/);
  assert.equal(omdbCalls.length, 0);
});

test('OMDB routes: need the edit permission', async () => {
  const { token } = await ctx.insertUser({ username: 'door-only', permissions: { view: false, edit: false, checkIn: true, marketing: false, admin: false } });
  const { status } = await ctx.request('GET', '/api/omdb/search?title=Jaws', { token });
  assert.equal(status, 403);
});
