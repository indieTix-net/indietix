import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { parseEmail, skipReason, replySubject, ticketNumberFromSubject, buildReplyMime } from '../src/mail.mjs';
import { rawEmail } from './helpers.mjs';

test('parseEmail: sender, subject, body, threading IDs and attachment names', async () => {
  const email = await parseEmail(rawEmail({ inReplyTo: '<r1@x>', references: '<r0@x> <r1@x>', attachment: 'screen.png' }));
  assert.equal(email.fromAddress, 'sam@venue.example');
  assert.equal(email.fromName, 'Sam Lee');
  assert.equal(email.subject, 'Scanner question');
  assert.match(email.bodyText, /camera will not start/);
  assert.equal(email.messageId, '<abc123@venue.example>');
  assert.deepEqual(email.references, ['<r1@x>', '<r0@x>']);
  assert.deepEqual(email.attachments.map(a => a.filename), ['screen.png']);
});

test('skipReason: real mail gets a draft; spam, viruses, our own address and automated mail do not', async () => {
  const ok = await parseEmail(rawEmail());
  assert.equal(skipReason(ok, { spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' } }), null);
  assert.equal(skipReason(ok, { spamVerdict: { status: 'FAIL' } }), 'spam');
  assert.equal(skipReason(ok, { virusVerdict: { status: 'FAIL' } }), 'virus');
  assert.equal(skipReason(await parseEmail(rawEmail({ from: 'indietix@indietix.net' }))), 'own_address');
  assert.equal(skipReason(await parseEmail(rawEmail({ from: 'MAILER-DAEMON@mx.example' }))), 'automated_sender');
  assert.equal(skipReason(await parseEmail(rawEmail({ headers: { 'Auto-Submitted': 'auto-replied' } }))), 'auto_reply');
  assert.equal(skipReason(await parseEmail(rawEmail({ headers: { 'Auto-Submitted': 'no' } }))), null);
  assert.equal(skipReason(await parseEmail(rawEmail({ headers: { Precedence: 'bulk' } }))), 'bulk');
  assert.equal(skipReason(await parseEmail(rawEmail({ headers: { 'List-Unsubscribe': '<mailto:x@y>' } }))), 'bulk');
});

test('replySubject and ticket tokens', () => {
  assert.equal(replySubject('Scanner question', 12), 'Re: Scanner question [T-12]');
  assert.equal(replySubject('RE: Scanner question', 12), 'RE: Scanner question [T-12]');
  assert.equal(replySubject('Re: Scanner question [T-12]', 12), 'Re: Scanner question [T-12]');
  assert.equal(ticketNumberFromSubject('Re: help [t-7]'), 7);
  assert.equal(ticketNumberFromSubject('no token'), null);
});

test('buildReplyMime: from support@, threaded, quoted, BCC only in the envelope, UTF-8 safe', async () => {
  const { raw, destinations, messageId } = buildReplyMime({
    to: 'sam@venue.example', toName: 'Sam Lee', subject: 'Re: Café question [T-3]', body: 'Hi Sam,\n\nIt works now.\n\nIndieTix Support',
    inReplyTo: '<abc123@venue.example>', references: ['<r0@x>'], bcc: 'me@example.com',
    quoted: { bodyText: 'Is it fixed?', fromName: 'Sam Lee', date: '2026-11-07T15:04:05Z' }
  });
  const parsed = await simpleParser(raw);
  assert.equal(parsed.from.value[0].address, 'support@indietix.net');
  assert.equal(parsed.to.value[0].address, 'sam@venue.example');
  assert.equal(parsed.subject, 'Re: Café question [T-3]');
  assert.equal(parsed.inReplyTo, '<abc123@venue.example>');
  assert.match(String(parsed.references), /<r0@x>/);
  assert.equal(parsed.messageId, messageId);
  assert.match(parsed.text, /It works now\.[\s\S]*Sam Lee wrote:\n> Is it fixed\?/);
  assert.ok(!/me@example\.com/.test(raw), 'BCC must not appear in the headers');
  assert.deepEqual(destinations, ['sam@venue.example', 'me@example.com']);
});
