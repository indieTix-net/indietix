import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// Must be imported BEFORE '../src/index.mjs' (see processWebhook.test.mjs).
import {
  startTestEnv, stopTestEnv, sesHandlers, resetSesHandlers, buildSqsEvent, buildSqsRecord
} from './helpers/webhookHarness.mjs';
import { handler } from '../src/index.mjs';

// oauth.authorization.revoked: a Connect Square venue removed IndieTix's
// access in Square. The venue is flagged and emailed once.

let ctx;
let emails;

before(async () => { ctx = await startTestEnv(); });
after(async () => { await stopTestEnv(ctx); });

beforeEach(async () => {
  resetSesHandlers();
  emails = [];
  sesHandlers.sendRawEmail = async (input) => {
    emails.push({ destinations: input.Destinations, raw: Buffer.from(input.RawMessage.Data).toString('utf8') });
    return { MessageId: 'm' };
  };
});

async function setConfig(extra) {
  await ctx.pgClient.query(
    `UPDATE "Client" SET configuration = (configuration::jsonb - 'SQUARE_AUTH_MODE' - 'SQUARE_OAUTH_REVOKED_AT' || $1::jsonb)::json WHERE "clientID" = $2`,
    [JSON.stringify(extra), ctx.clientId]
  );
}
async function storedConfig() {
  const { rows } = await ctx.pgClient.query('SELECT configuration FROM "Client" WHERE "clientID" = $1', [ctx.clientId]);
  return typeof rows[0].configuration === 'string' ? JSON.parse(rows[0].configuration) : rows[0].configuration;
}
const revokedEvent = () => buildSqsEvent([buildSqsRecord({
  merchant_id: ctx.clientId,
  type: 'oauth.authorization.revoked',
  event_id: 'evt-1',
  data: { type: 'revocation', object: { revocation: { revoked_at: '2026-11-02T15:00:00Z', revoker_type: 'MERCHANT' } } }
})]);

test('revoked: a Connect Square venue is flagged and emailed once', async () => {
  await setConfig({ SQUARE_AUTH_MODE: 'oauth' });
  await handler(revokedEvent());
  const flagged = (await storedConfig()).SQUARE_OAUTH_REVOKED_AT;
  assert.ok(flagged && !Number.isNaN(Date.parse(flagged)));
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].destinations, ['contact@example.com']);
  assert.match(emails[0].raw, /Square was disconnected for Test Venue/);
  assert.match(emails[0].raw, /Reconnect Square/);

  // Square repeating the event changes nothing and sends nothing more.
  await handler(revokedEvent());
  assert.equal((await storedConfig()).SQUARE_OAUTH_REVOKED_AT, flagged);
  assert.equal(emails.length, 1);
});

test('revoked: a personal-token venue (Liberty Hall) is left alone', async () => {
  await setConfig({});
  await handler(revokedEvent());
  assert.equal((await storedConfig()).SQUARE_OAUTH_REVOKED_AT, undefined);
  assert.equal(emails.length, 0);
});
