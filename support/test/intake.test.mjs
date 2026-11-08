import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import pg from 'pg';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createPgQuery } from '../src/db.mjs';
import { receiveEmail, handleEvent } from '../src/intake.mjs';
import { getMessages, getTicket, listTickets, deleteExpired } from '../src/store.mjs';
import { rawEmail, fakeAnthropic } from './helpers.mjs';

let containerName, client, query;

before(async () => {
  let dbConfig;
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'indietix' }));
  client = new pg.Client(dbConfig);
  await client.connect();
  await client.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  await client.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); // safe to re-run
  query = createPgQuery(client);
});
after(async () => { await client.end(); await teardownTestDatabase(containerName); });
beforeEach(async () => { await client.query('TRUNCATE "SupportTicket", "SupportMessage" RESTART IDENTITY'); });

const deps = (anthropic = fakeAnthropic(), extra = {}) => ({ query, anthropic: async () => anthropic, knowledge: 'K', ...extra });

test('a new email opens a ticket, is stored, and gets a draft', async () => {
  const anthropic = fakeAnthropic();
  const result = await receiveEmail(deps(anthropic), { raw: rawEmail({ attachment: 'screen.png' }), s3Key: 'support/m1' });
  assert.equal(result.isNew, true);
  assert.equal(result.drafted, true);
  const ticket = await getTicket(query, result.ticketId);
  assert.equal(ticket.CustomerEmail, 'sam@venue.example');
  assert.equal(ticket.Status, 'open');
  const [m] = await getMessages(query, result.ticketId);
  assert.equal(m.S3Key, 'support/m1');
  assert.deepEqual(m.Attachments.map(a => a.filename), ['screen.png']);
  assert.match(m.Draft, /IndieTix Support/);
  assert.equal(m.DraftModel, 'claude-opus-5-5');
  assert.equal(anthropic.calls.length, 1);
});

test('the same email delivered twice is stored once', async () => {
  await receiveEmail(deps(), { raw: rawEmail(), s3Key: 'k' });
  const again = await receiveEmail(deps(), { raw: rawEmail(), s3Key: 'k' });
  assert.equal(again.duplicate, true);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM "SupportMessage"');
  assert.equal(rows[0].n, 1);
});

test('a reply threads onto its ticket by In-Reply-To, and reopens it', async () => {
  const first = await receiveEmail(deps(), { raw: rawEmail(), s3Key: 'k1' });
  await client.query(`UPDATE "SupportTicket" SET "Status" = 'waiting'`);
  const reply = await receiveEmail(deps(), { raw: rawEmail({ messageId: '<m2@venue.example>', subject: 'Re: Scanner question', inReplyTo: '<abc123@venue.example>' }), s3Key: 'k2' });
  assert.equal(reply.ticketId, first.ticketId);
  assert.equal((await getTicket(query, first.ticketId)).Status, 'open');
});

test('a [T-n] subject token threads only for the same sender', async () => {
  const first = await receiveEmail(deps(), { raw: rawEmail(), s3Key: 'k1' });
  const same = await receiveEmail(deps(), { raw: rawEmail({ messageId: '<m2@x>', subject: `Re: help [T-${first.ticketId}]` }), s3Key: 'k2' });
  assert.equal(same.ticketId, first.ticketId);
  const stranger = await receiveEmail(deps(), { raw: rawEmail({ messageId: '<m3@x>', from: 'other@else.example', subject: `Re: help [T-${first.ticketId}]` }), s3Key: 'k3' });
  assert.notEqual(stranger.ticketId, first.ticketId);
});

test('spam and auto-replies are stored without calling the model', async () => {
  const anthropic = fakeAnthropic();
  const spam = await receiveEmail(deps(anthropic), { raw: rawEmail({ messageId: '<s1@x>' }), s3Key: 'k', receipt: { spamVerdict: { status: 'FAIL' } } });
  assert.equal(spam.skipped, 'spam');
  assert.equal((await getTicket(query, spam.ticketId)).Status, 'spam');
  const ooo = await receiveEmail(deps(anthropic), { raw: rawEmail({ messageId: '<o1@x>', from: 'away@else.example', headers: { 'Auto-Submitted': 'auto-replied' } }), s3Key: 'k' });
  assert.equal((await getTicket(query, ooo.ticketId)).Status, 'closed');
  assert.equal(anthropic.calls.length, 0);
});

test('if drafting fails the email is still stored, for Regenerate to retry', async () => {
  const result = await receiveEmail(deps(fakeAnthropic({ fail: 'overloaded' })), { raw: rawEmail(), s3Key: 'k' });
  assert.equal(result.drafted, false);
  const [m] = await getMessages(query, result.ticketId);
  assert.equal(m.Draft, null);
});

test('past the daily draft limit, emails are filed without a draft and only the first sends a notice', async () => {
  const anthropic = fakeAnthropic();
  const notices = [];
  const d = deps(anthropic, { dailyDraftLimit: 2, notify: async (n) => notices.push(n) });
  const results = [];
  for (let i = 1; i <= 4; i++) {
    results.push(await receiveEmail(d, { raw: rawEmail({ messageId: `<flood${i}@x>`, from: `p${i}@else.example` }), s3Key: `k${i}` }));
  }
  assert.deepEqual(results.map(r => r.drafted), [true, true, false, false]);
  assert.equal(results[2].overLimit, true);
  assert.equal(anthropic.calls.length, 2);
  assert.deepEqual(notices.map(n => n.limitReached), [null, null, 2]);
  // Regenerate from the inbox isn't limited.
  const redraft = await handleEvent({ action: 'draft', ticketId: results[3].ticketId }, d);
  assert.ok(redraft.draft);
  // Spam doesn't use up the limit, and the limit is per 24 hours.
  await client.query(`UPDATE "SupportMessage" SET "CreatedDate" = now() - interval '25 hours'`);
  await receiveEmail(d, { raw: rawEmail({ messageId: '<s@x>' }), s3Key: 'ks', receipt: { spamVerdict: { status: 'FAIL' } } });
  const next = await receiveEmail(d, { raw: rawEmail({ messageId: '<next@x>', from: 'n@else.example' }), s3Key: 'kn' });
  assert.equal(next.drafted, true);
});

test('handleEvent: an SES event reads the raw email from the support/ prefix; {action:"draft"} redrafts', async () => {
  const keys = [];
  const anthropic = fakeAnthropic({ text: 'Second draft' });
  const d = deps(anthropic, { getRaw: async (key) => { keys.push(key); return rawEmail(); } });
  const event = { Records: [{ eventSource: 'aws:ses', ses: { mail: { messageId: 'sesid1', source: 'sam@venue.example' }, receipt: { spamVerdict: { status: 'PASS' } } } }] };
  const result = await handleEvent(event, d);
  assert.deepEqual(keys, ['support/sesid1']);
  const redraft = await handleEvent({ action: 'draft', ticketId: result.ticketId }, d);
  assert.equal(redraft.draft, 'Second draft');
  assert.equal((await handleEvent({ action: 'draft', ticketId: 999 }, d)).error, 'ticket not found');
});

test('list shows tickets with messages; tickets idle for 2+ years are deleted', async () => {
  const live = await receiveEmail(deps(), { raw: rawEmail(), s3Key: 'k1' });
  const old = await receiveEmail(deps(), { raw: rawEmail({ messageId: '<old@x>', from: 'old@else.example' }), s3Key: 'k2' });
  await client.query(`UPDATE "SupportTicket" SET "LastMessageDate" = now() - interval '2 years 1 day' WHERE "ID" = $1`, [old.ticketId]);
  assert.equal(await deleteExpired(query), 1);
  const ids = (await listTickets(query)).map(t => t.ID);
  assert.deepEqual(ids, [live.ticketId]);
  assert.equal((await getMessages(query, old.ticketId)).length, 0);
});
