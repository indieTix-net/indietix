import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({ clientConfig: { STATIC_WEBSITE_URL: 'https://example.com' } });
});
after(async () => { await stopTestServer(ctx); });

// Order matters in this file: globalConfig is a module-level singleton
// that only gets populated by some OTHER request's own
// getClientConfiguration() call (/login itself is unauthenticated, so it
// never populates it). This test must run before anything else in this
// file touches globalConfig, so it observes the same pristine state a
// real cold Lambda start (or any request landing before the container's
// warm globalConfig gets set) would see.
test('GET /login: with no client config populated yet, fails explicitly rather than leaking another client\'s URL', async () => {
  const res = await fetch(`${ctx.baseUrl}/login`, { redirect: 'manual' });
  assert.equal(res.status, 503);
});

test('GET /login: once populated, redirects to the client\'s own hosted login page', async () => {
  await ctx.request('GET', '/api/client/branding', { token: ctx.clientToken });
  const res = await fetch(`${ctx.baseUrl}/login`, { redirect: 'manual' });
  assert.ok([301, 302, 307, 308].includes(res.status));
  assert.equal(res.headers.get('location'), 'https://example.com/login.html');
});

test('GET /: requires auth', async () => {
  const { status } = await ctx.request('GET', '/');
  assert.equal(status, 401);
});

test('GET /: a valid client token gets the operator UI shell', async () => {
  const { status, text } = await ctx.request('GET', '/', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.match(text, /<html|<!DOCTYPE/i);
});
