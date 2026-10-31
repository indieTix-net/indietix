import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, sesHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "Users"`);
});

test('POST /api/forgot-password: a known user email gets a reset email and a generic success response', async () => {
  await ctx.insertUser({ username: 'resetme', email: 'resetme@example.com' });
  let captured;
  sesHandlers.sendRawEmail = async (params) => { captured = params; return { MessageId: 'mock-id' }; };

  const { status, json } = await ctx.request('POST', '/api/forgot-password', {
    body: { email: 'resetme@example.com', clientId: ctx.clientId }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.ok(captured, 'an email should have been sent');
  // Comes from the venue's SENDER_EMAIL (Client Settings), like every other email.
  assert.match(captured.RawMessage.Data.toString(), /^From: noreply@example\.com/m);
});

test('POST /api/forgot-password: an unknown email still gets a generic success response (no account enumeration)', async () => {
  let emailSent = false;
  sesHandlers.sendRawEmail = async () => { emailSent = true; return { MessageId: 'mock-id' }; };

  const { status, json } = await ctx.request('POST', '/api/forgot-password', {
    body: { email: 'nobody@example.com', clientId: ctx.clientId }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(emailSent, false, 'no email should actually be sent for an unknown address');
});

test('POST /api/forgot-password: missing email or clientId is a 400', async () => {
  const { status } = await ctx.request('POST', '/api/forgot-password', { body: { email: 'x@example.com' } });
  assert.equal(status, 400);
});

test('POST /api/forgot-password: an unknown clientId fails cleanly (bad DB credentials -> 500, not a crash)', async () => {
  const { status } = await ctx.request('POST', '/api/forgot-password', {
    body: { email: 'x@example.com', clientId: 'NOSUCHCLIENT999' }
  });
  assert.equal(status, 500);
});

// ---- reset-password ----

// mailcomposer's text body is quoted-printable encoded (soft line-wraps at
// 76 chars, "=" becomes "=3D") -- decode before pulling the token out, or
// a `=` inside the token (or a wrap landing mid-token) corrupts it.
function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r\n/g, '')
    .replace(/=\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function requestResetToken(email) {
  let captured;
  sesHandlers.sendRawEmail = async (params) => { captured = params; return { MessageId: 'mock-id' }; };
  await ctx.request('POST', '/api/forgot-password', { body: { email, clientId: ctx.clientId } });
  const decoded = decodeQuotedPrintable(captured.RawMessage.Data.toString('utf8'));
  const match = decoded.match(/token=([^&\s]+)/);
  return match ? match[1] : null;
}

test('POST /api/reset-password: a valid token resets the password', async () => {
  await ctx.insertUser({ username: 'resetter1', email: 'resetter1@example.com', password: 'old-password' });
  const token = await requestResetToken('resetter1@example.com');
  assert.ok(token, 'must have extracted a reset token from the email body');

  const { status, json } = await ctx.request('POST', '/api/reset-password', {
    body: { token, email: 'resetter1@example.com', password: 'new-password-123', repeatPassword: 'new-password-123', clientId: ctx.clientId }
  });
  assert.equal(status, 200);
  assert.equal(json.success, true);

  const login = await ctx.request('POST', '/api/login', {
    body: { username: 'resetter1', password: 'new-password-123', clientId: ctx.clientId }
  });
  assert.equal(login.status, 200);
});

test('POST /api/reset-password: mismatched password/repeatPassword rejected with 400', async () => {
  const { status, json } = await ctx.request('POST', '/api/reset-password', {
    body: { token: 'whatever', email: 'x@example.com', password: 'a', repeatPassword: 'b', clientId: ctx.clientId }
  });
  assert.equal(status, 400);
  assert.match(json.message, /match/);
});

test('POST /api/reset-password: missing fields rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/reset-password', { body: { clientId: ctx.clientId } });
  assert.equal(status, 400);
});

test('POST /api/reset-password: a garbage token is rejected as invalid, not a crash', async () => {
  const { status, json } = await ctx.request('POST', '/api/reset-password', {
    body: { token: 'not-a-real-token', email: 'x@example.com', password: 'new-pw-12345', repeatPassword: 'new-pw-12345', clientId: ctx.clientId }
  });
  assert.equal(status, 400);
  assert.match(json.message, /Invalid|expired/);
});

test('POST /api/reset-password: a token issued for a different email is rejected', async () => {
  await ctx.insertUser({ username: 'resetter2', email: 'resetter2@example.com' });
  const token = await requestResetToken('resetter2@example.com');

  const { status, json } = await ctx.request('POST', '/api/reset-password', {
    body: { token, email: 'someone-else@example.com', password: 'new-pw-12345', repeatPassword: 'new-pw-12345', clientId: ctx.clientId }
  });
  assert.equal(status, 400);
  assert.match(json.message, /does not match/);
});

test('POST /api/reset-password: a valid token for a now-deleted user returns 404', async () => {
  await ctx.insertUser({ username: 'resetter3', email: 'resetter3@example.com' });
  const token = await requestResetToken('resetter3@example.com');
  await ctx.pgClient.query(`DELETE FROM "Users" WHERE "Email" = 'resetter3@example.com'`);

  const { status, json } = await ctx.request('POST', '/api/reset-password', {
    body: { token, email: 'resetter3@example.com', password: 'new-pw-12345', repeatPassword: 'new-pw-12345', clientId: ctx.clientId }
  });
  assert.equal(status, 404);
  assert.equal(json.message, 'User not found');
});
