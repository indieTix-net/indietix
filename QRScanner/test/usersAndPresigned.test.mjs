import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, s3Handlers } from './helpers/testServer.mjs';

let ctx;

before(async () => { ctx = await startTestServer(); });
after(async () => { await stopTestServer(ctx); });

beforeEach(async () => {
  await ctx.pgClient.query(`DELETE FROM "Users"`);
  await ctx.pgClient.query(`DELETE FROM "QRCodeProduct"`);
});

// ---- Users CRUD ----

test('POST /api/users: client creates a new sub-user', async () => {
  const { status, json } = await ctx.request('POST', '/api/users', {
    token: ctx.clientToken,
    body: { username: 'newuser', password: 'pw123456', email: 'new@example.com', firstName: 'New', lastName: 'User' }
  });
  assert.equal(status, 200);
  assert.equal(json.user.Username, 'newuser');
  assert.equal(json.user.Password, undefined, 'password hash must never be returned');
});

test('POST /api/users: duplicate username is rejected', async () => {
  await ctx.insertUser({ username: 'dupuser' });
  const { status, json } = await ctx.request('POST', '/api/users', {
    token: ctx.clientToken,
    body: { username: 'dupuser', password: 'pw123456', email: 'dup2@example.com' }
  });
  assert.equal(status, 400);
  assert.match(json.message, /already exists/);
});

test('POST /api/users: missing required fields rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/users', { token: ctx.clientToken, body: { username: 'x' } });
  assert.equal(status, 400);
});

test('GET /api/users: lists users without exposing password hashes', async () => {
  await ctx.insertUser({ username: 'listme' });
  const { status, json } = await ctx.request('GET', '/api/users', { token: ctx.clientToken });
  assert.equal(status, 200);
  assert.ok(json.users.find(u => u.Username === 'listme'));
  assert.ok(json.users.every(u => u.Password === undefined));
});

test('PUT /api/users/:userId: updates only the provided fields', async () => {
  const { id } = await ctx.insertUser({ username: 'edituser', email: 'old@example.com' });
  const { status, json } = await ctx.request('PUT', `/api/users/${id}`, {
    token: ctx.clientToken, body: { email: 'new@example.com' }
  });
  assert.equal(status, 200);
  assert.equal(json.user.Email, 'new@example.com');
  assert.equal(json.user.Username, 'edituser', 'untouched field preserved');
});

test('PUT /api/users/:userId: a nonexistent user returns 404', async () => {
  const { status } = await ctx.request('PUT', '/api/users/999999', { token: ctx.clientToken, body: { email: 'x@example.com' } });
  assert.equal(status, 404);
});

test('DELETE /api/users/:userId: removes the user', async () => {
  const { id } = await ctx.insertUser({ username: 'deleteme' });
  const { status } = await ctx.request('DELETE', `/api/users/${id}`, { token: ctx.clientToken });
  assert.equal(status, 200);
  const check = await ctx.pgClient.query(`SELECT * FROM "Users" WHERE "ID" = $1`, [id]);
  assert.equal(check.rows.length, 0);
});

test('DELETE /api/users/:userId: a nonexistent user returns 404', async () => {
  const { status } = await ctx.request('DELETE', '/api/users/999999', { token: ctx.clientToken });
  assert.equal(status, 404);
});

// ---- Presigned URLs ----

async function insertTicket(qrCode, status = 'valid') {
  await ctx.pgClient.query(
    `INSERT INTO "QRCodeProduct" ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductID", "Status")
     VALUES ($1, '2099-01-01', '2026-01-01 19:00:00', 'Movie', 'Main', 'Movie', 'details', 'ITEM', $2)`,
    [qrCode, status]
  );
}

test('POST /api/presigned-download: a valid ticket gets a signed URL', async () => {
  await insertTicket('QR-DOWNLOAD-1', 'valid');
  const { status, json } = await ctx.request('POST', '/api/presigned-download', { token: ctx.clientToken, body: { qrCode: 'QR-DOWNLOAD-1' } });
  assert.equal(status, 200);
  assert.ok(json.downloadUrl.includes('QR-Ticket-QR-DOWNLOAD-1.pdf'));
});

test('POST /api/presigned-download: a refunded ticket is refused (403), not just silently signed', async () => {
  await insertTicket('QR-DOWNLOAD-2', 'refunded');
  const { status, json } = await ctx.request('POST', '/api/presigned-download', { token: ctx.clientToken, body: { qrCode: 'QR-DOWNLOAD-2' } });
  assert.equal(status, 403);
  assert.match(json.message, /refunded/);
});

test('POST /api/presigned-download: a nonexistent QR code returns 404', async () => {
  const { status } = await ctx.request('POST', '/api/presigned-download', { token: ctx.clientToken, body: { qrCode: 'QR-DOES-NOT-EXIST' } });
  assert.equal(status, 404);
});

test('POST /api/presigned-upload: rejects a non-image content type', async () => {
  const { status, json } = await ctx.request('POST', '/api/presigned-upload', {
    token: ctx.clientToken, body: { fileName: 'file.txt', contentType: 'text/plain' }
  });
  assert.equal(status, 400);
  assert.match(json.error, /image/);
});

test('POST /api/presigned-upload: sanitizes the filename and respects an optional folder prefix', async () => {
  const { status, json } = await ctx.request('POST', '/api/presigned-upload', {
    token: ctx.clientToken, body: { fileName: 'my poster!!.jpg', contentType: 'image/jpeg', folder: 'movie-posters' }
  });
  assert.equal(status, 200);
  assert.match(json.fileUrl, /movie-posters\/my_poster__\.jpg$/);
});

test('POST /api/presigned-upload: refuses any folder but movie-posters (e.g. tickets-out, where ticket PDFs live)', async () => {
  const { status } = await ctx.request('POST', '/api/presigned-upload', {
    token: ctx.clientToken, body: { fileName: 'ticket.jpg', contentType: 'image/jpeg', folder: 'tickets-out' }
  });
  assert.equal(status, 400);
});

test('POST /api/presigned-upload: with no folder given, still lands in movie-posters/', async () => {
  const { status, json } = await ctx.request('POST', '/api/presigned-upload', {
    token: ctx.clientToken, body: { fileName: 'poster.jpg', contentType: 'image/jpeg' }
  });
  assert.equal(status, 200);
  assert.match(json.fileUrl, /movie-posters\/poster\.jpg$/);
});

test('POST /api/presigned-upload: an S3 signing failure surfaces as a 500, not a silent success', async () => {
  s3Handlers.getSignedUrlPromise = async () => { throw new Error('mock S3 signing failure'); };
  const { status } = await ctx.request('POST', '/api/presigned-upload', {
    token: ctx.clientToken, body: { fileName: 'x.jpg', contentType: 'image/jpeg' }
  });
  assert.equal(status, 500);
});
