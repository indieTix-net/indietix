import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

test('GET /api/health: public, no auth required', async () => {
  const { status, json } = await ctx.request('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
});

test('GET /api/logout: public, always succeeds (JWT logout is client-side only)', async () => {
  const { status, json } = await ctx.request('GET', '/api/logout');
  assert.equal(status, 200);
  assert.equal(json.success, true);
});

test('POST /api/login: client login with correct credentials returns a client-type token', async () => {
  const { status, json } = await ctx.request('POST', '/api/login', {
    body: { username: ctx.clientId, password: 'client-password', clientId: ctx.clientId }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.userType, 'client');
  assert.ok(json.token);
});

test('POST /api/login: client login with the wrong password is rejected', async () => {
  const { status, json } = await ctx.request('POST', '/api/login', {
    body: { username: ctx.clientId, password: 'wrong-password', clientId: ctx.clientId }
  });
  assert.equal(status, 401);
  assert.equal(json.success, false);
});

test('POST /api/login: a sub-user can log in with their own username/password and gets a user-type token', async () => {
  await ctx.insertUser({ username: 'subuser1', password: 'sub-password' });
  const { status, json } = await ctx.request('POST', '/api/login', {
    body: { username: 'subuser1', password: 'sub-password', clientId: ctx.clientId }
  });
  assert.equal(status, 200);
  assert.equal(json.userType, 'user');
  assert.ok(json.token);
});

test('POST /api/login: missing fields are rejected with 400, not a 500', async () => {
  const { status, json } = await ctx.request('POST', '/api/login', { body: { username: ctx.clientId } });
  assert.equal(status, 400);
  assert.equal(json.success, false);
});

test('POST /api/login: an unknown clientId fails cleanly (bad DB credentials -> 401, not a crash)', async () => {
  const { status } = await ctx.request('POST', '/api/login', {
    body: { username: 'whoever', password: 'whatever', clientId: 'NOSUCHCLIENT999' }
  });
  assert.equal(status, 401);
});

test('requireAuth: a protected route with no Authorization header is rejected', async () => {
  const { status, json } = await ctx.request('GET', '/api/client/branding');
  assert.equal(status, 401);
  assert.equal(json.success, false);
});

test('requireAuth: a malformed/garbage token is rejected', async () => {
  const { status } = await ctx.request('GET', '/api/client/branding', { token: 'not-a-real-jwt' });
  assert.equal(status, 401);
});

test('requireAuth: a token signed with the WRONG secret is rejected even though it decodes fine', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const forgedToken = jwt.sign({ username: ctx.clientId, dbName: ctx.clientId, userType: 'client' }, 'wrong-secret');
  const { status } = await ctx.request('GET', '/api/client/branding', { token: forgedToken });
  assert.equal(status, 401);
});

test('requireAuth: a valid client token grants access to a protected route', async () => {
  const { status, json } = await ctx.request('GET', '/api/client/branding', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.equal(json.success, true);
});

test('requireAuth: a token for a DIFFERENT (nonexistent) client is rejected, not silently allowed through', async () => {
  const forgedToken = ctx.signToken({ username: 'SOMEOTHERCLIENT999', dbName: 'SOMEOTHERCLIENT999', userType: 'client' });
  const { status } = await ctx.request('GET', '/api/client/branding', { token: forgedToken });
  assert.equal(status, 401);
});

test('requireClientAuth: a sub-user is denied from a client-only route', async () => {
  const { token } = await ctx.insertUser({ username: 'subuser2' });
  const { status, json } = await ctx.request('GET', '/api/users', { token });
  assert.equal(status, 403);
  assert.equal(json.success, false);
});

test('requireClientAuth: the client itself can access a client-only route', async () => {
  const { status } = await ctx.request('GET', '/api/users', { token: ctx.clientToken });
  assert.equal(status, 200);
});
