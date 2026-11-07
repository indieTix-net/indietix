import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import pg from 'pg';
import { simpleParser } from 'mailparser';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createPgQuery } from '../src/db.mjs';
import { receiveEmail } from '../src/intake.mjs';
import { getMessages, getTicket } from '../src/store.mjs';
import { createInboxServer } from '../inbox/server.mjs';
import { rawEmail, fakeAnthropic } from './helpers.mjs';

let containerName, client, query, server, base, key, sent, ticketId;

before(async () => {
  let dbConfig;
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'indietix' }));
  client = new pg.Client(dbConfig);
  await client.connect();
  await client.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  query = createPgQuery(client);
  ({ ticketId } = await receiveEmail({ query, anthropic: async () => fakeAnthropic(), knowledge: 'K' }, { raw: rawEmail(), s3Key: 'k' }));
  sent = [];
  ({ server, key } = createInboxServer({ query, sendRaw: async (m) => { sent.push(m); }, redraft: async (id) => ({ draft: `redrafted ${id}` }), bcc: 'me@example.com', sender: 'josh' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await client.end(); await teardownTestDatabase(containerName); });

const call = (path, { body, withKey = true } = {}) => fetch(base + path, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(withKey ? { 'x-inbox-key': key } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

test('the page and the API refuse requests without the key', async () => {
  assert.equal((await fetch(`${base}/`)).status, 403);
  assert.equal((await fetch(`${base}/?key=wrong`)).status, 403);
  assert.equal((await fetch(`${base}/?key=${key}`)).status, 200);
  assert.equal((await call('/api/tickets', { withKey: false })).status, 403);
});

test('lists tickets and shows a conversation with its draft', async () => {
  const { tickets } = await (await call('/api/tickets?status=open')).json();
  assert.equal(tickets[0].ID, ticketId);
  const { messages } = await (await call(`/api/tickets/${ticketId}`)).json();
  assert.match(messages[0].Draft, /IndieTix Support/);
});

test('send: emails the reply from support@, threads it, records it, and marks the ticket waiting', async () => {
  const res = await call(`/api/tickets/${ticketId}/send`, { body: { body: 'Hi Sam,\n\nFixed.\n\nIndieTix Support' } });
  assert.equal(res.status, 200);
  const parsed = await simpleParser(sent[0].raw);
  assert.equal(parsed.from.value[0].address, 'support@indietix.net');
  assert.equal(parsed.inReplyTo, '<abc123@venue.example>');
  assert.equal(parsed.subject, `Re: Scanner question [T-${ticketId}]`);
  assert.deepEqual(sent[0].destinations, ['sam@venue.example', 'me@example.com']);
  const messages = await getMessages(query, ticketId);
  assert.equal(messages.at(-1).Direction, 'out');
  assert.equal(messages.at(-1).SentBy, 'josh');
  assert.equal((await getTicket(query, ticketId)).Status, 'waiting');
});

test('an empty reply is refused; redraft and status changes work', async () => {
  assert.equal((await call(`/api/tickets/${ticketId}/send`, { body: { body: '  ' } })).status, 400);
  assert.equal((await (await call(`/api/tickets/${ticketId}/redraft`, { body: {} })).json()).draft, `redrafted ${ticketId}`);
  assert.equal((await call(`/api/tickets/${ticketId}/status`, { body: { status: 'nonsense' } })).status, 400);
  assert.equal((await (await call(`/api/tickets/${ticketId}/status`, { body: { status: 'closed' } })).json()).ticket.Status, 'closed');
});
