import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

// Behind the API edge (CloudFront + WAF), requests without CloudFront's
// X-IndieTix-Edge header went around the firewall and are refused.

const SECRET = 'edge-secret-0123456789abcdef0123456789';
let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => {
  delete process.env.EDGE_ORIGIN_SECRET;
  await stopTestServer(ctx);
});

test('without EDGE_ORIGIN_SECRET (self-hosted, Liberty Hall) nothing is checked', async () => {
  delete process.env.EDGE_ORIGIN_SECRET;
  const { status } = await ctx.request('GET', '/api/client', { token: ctx.clientToken });
  assert.equal(status, 200);
});

test('with it, requests need the exact header', async () => {
  process.env.EDGE_ORIGIN_SECRET = SECRET;
  for (const headers of [{}, { 'x-indietix-edge': 'wrong' }, { 'x-indietix-edge': SECRET.slice(0, -1) }]) {
    const { status } = await ctx.request('GET', '/api/client', { token: ctx.clientToken, headers });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  const publicRoute = await ctx.request('GET', '/api/public/signup/config');
  assert.equal(publicRoute.status, 403, 'public routes too');
  const { status } = await ctx.request('GET', '/api/client', { token: ctx.clientToken, headers: { 'x-indietix-edge': SECRET } });
  assert.equal(status, 200);
});
