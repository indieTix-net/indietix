import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { sendSms, buildMessageBody } from '../src/sms.mjs';

// sendSms's SQL (consent lookup, spend-limit count, outbound log insert/prune)
// is simple parameterized CRUD, not the correctness-critical SQL functions
// (bdor_for_date etc.) that need a real Postgres engine to mean anything --
// a hand-rolled fake pool is the right level of infrastructure here.
//
// Queued responses are consumed in order; any call beyond what's queued
// (most commonly the ~1%-probability prune query) gets a generic empty
// result instead of throwing, so tests aren't flaky based on Math.random().
class FakePool {
  constructor(responses = []) {
    this.queue = [...responses];
    this.calls = [];
  }
  async query(sql, params) {
    this.calls.push({ sql, params });
    const next = this.queue.shift();
    if (next === undefined) return { rows: [], rowCount: 0 };
    if (next instanceof Error) throw next;
    return next;
  }
}

const smsMock = mockClient(PinpointSMSVoiceV2Client);

const baseClientConfig = {
  SEND_SMS: 'true',
  SMS_ORIGINATION_NUMBER: '+19135550000',
  SMS_SENDER_BRAND: 'Liberty Hall'
};

test('sendSms: master kill switch blocks send when SEND_SMS is not "true"', async () => {
  smsMock.reset();
  const pool = new FakePool([]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: { ...baseClientConfig, SEND_SMS: 'false' },
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'sms_disabled' });
  assert.equal(pool.calls.length, 0, 'should not touch the DB at all when disabled');
});

test('sendSms: also respects SEND_SMS as a real boolean true (Postgres JSON boolean vs string)', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-1' });
  const pool = new FakePool([{ rows: [{ ID: 1 }] }, { rows: [{ cnt: 0 }] }]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: { ...baseClientConfig, SEND_SMS: true },
    pool
  });
  assert.equal(result.sent, true);
});

test('sendSms: blocks when SMS_ORIGINATION_NUMBER is missing', async () => {
  smsMock.reset();
  const pool = new FakePool([]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: { ...baseClientConfig, SMS_ORIGINATION_NUMBER: undefined },
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'missing_origination' });
});

test('sendSms: rejects an unnormalizable phone number before touching the DB', async () => {
  smsMock.reset();
  const pool = new FakePool([]);
  const result = await sendSms({
    toPhone: 'not a phone number', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'invalid_phone' });
  assert.equal(pool.calls.length, 0);
});

test('sendSms: refuses to send with no active SmsConsent row', async () => {
  smsMock.reset();
  const pool = new FakePool([{ rows: [] }]); // consent check returns no rows
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'no_consent' });
  assert.equal(smsMock.calls().length, 0, 'should never call AWS without consent');
});

test('sendSms: bypassConsentCheck skips the consent query entirely', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-bypass' });
  // No consent row queued at all -- if sendSms tried to check consent this
  // would consume the spend-limit response instead and the test would still
  // pass by accident, so assert on the actual SQL text of the first call too.
  const pool = new FakePool([{ rows: [{ cnt: 0 }] }]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'STOP auto-reply',
    clientConfig: baseClientConfig,
    pool,
    bypassConsentCheck: true
  });
  assert.equal(result.sent, true);
  assert.ok(pool.calls.length >= 1);
  assert.match(pool.calls[0].sql, /SmsOutboundLog/, 'first query should be the spend-limit count, not a consent check');
});

test('sendSms: circuit breaker trips when recent send count meets the limit', async () => {
  smsMock.reset();
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },        // active consent
    { rows: [{ cnt: 300 }] }      // at the default limit
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'spend_limit_exceeded' });
  assert.equal(smsMock.calls().length, 0);
});

test('sendSms: a per-client SMS_SPEND_LIMIT_PER_5MIN override is honored', async () => {
  smsMock.reset();
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    { rows: [{ cnt: 5 }] }
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: { ...baseClientConfig, SMS_SPEND_LIMIT_PER_5MIN: 4 },
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'spend_limit_exceeded' });
});

test('sendSms: the daily cap stops sends once the last 24 hours reach the default 1,000', async () => {
  smsMock.reset();
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },                    // active consent
    { rows: [{ cnt: 0, day_cnt: 1000 }] }     // quiet 5 minutes, full day
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'daily_limit_exceeded' });
  assert.equal(smsMock.calls().length, 0);
  assert.match(pool.calls[1].sql, /INTERVAL '24 hours'/);
});

test('sendSms: under the daily cap still sends', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-under-cap' });
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    { rows: [{ cnt: 0, day_cnt: 999 }] },
    { rows: [] }                              // SmsOutboundLog insert
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.equal(result.sent, true);
});

test('sendSms: a per-client SMS_DAILY_LIMIT override is honored', async () => {
  smsMock.reset();
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    { rows: [{ cnt: 0, day_cnt: 50 }] }
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: { ...baseClientConfig, SMS_DAILY_LIMIT: 50 },
    pool
  });
  assert.deepEqual(result, { sent: false, reason: 'daily_limit_exceeded' });
});

test('sendSms: spend-limit check query failing fails OPEN (still sends)', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-failopen' });
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    new Error('connection terminated unexpectedly')
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.equal(result.sent, true, 'a broken spend-limit query must not block a real send');
});

test('sendSms: successful send returns messageId and logs to SmsOutboundLog with a truncated body preview', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-success' });
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    { rows: [{ cnt: 0 }] }
  ]);
  const longBody = 'x'.repeat(200);
  const result = await sendSms({
    toPhone: '9135551234', body: longBody,
    clientConfig: baseClientConfig,
    pool
  });
  assert.deepEqual(result, { sent: true, reason: 'sent', messageId: 'msg-success' });

  const logCall = pool.calls.find(c => /INSERT INTO "SmsOutboundLog"/.test(c.sql));
  assert.ok(logCall, 'expected an INSERT into SmsOutboundLog');
  assert.equal(logCall.params[0], '+19135551234');
  assert.equal(logCall.params[1], 'msg-success');
  assert.equal(logCall.params[2].length, 160, 'body preview must be truncated to 160 chars');

  const sendCall = smsMock.commandCalls(SendTextMessageCommand)[0];
  assert.equal(sendCall.args[0].input.DestinationPhoneNumber, '+19135551234');
  assert.equal(sendCall.args[0].input.OriginationIdentity, baseClientConfig.SMS_ORIGINATION_NUMBER);
  assert.equal(sendCall.args[0].input.MessageType, 'TRANSACTIONAL');
});

test('sendSms: a failed outbound log insert does not undo a successful send', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-logfail' });
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    { rows: [{ cnt: 0 }] },
    new Error('insert failed')
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.deepEqual(result, { sent: true, reason: 'sent', messageId: 'msg-logfail' });
});

test('sendSms: AWS send failure is reported, not thrown', async () => {
  smsMock.reset();
  smsMock.on(SendTextMessageCommand).rejects(new Error('ConflictException: opted out'));
  const pool = new FakePool([
    { rows: [{ ID: 1 }] },
    { rows: [{ cnt: 0 }] }
  ]);
  const result = await sendSms({
    toPhone: '9135551234', body: 'hi',
    clientConfig: baseClientConfig,
    pool
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'aws_error');
  assert.match(result.error, /ConflictException/);
});

test('buildMessageBody: default brand and required STOP/HELP footer', () => {
  const body = buildMessageBody(undefined, 'Your ticket is ready.');
  assert.match(body, /^IndieTix: Your ticket is ready\./);
  assert.match(body, /Reply STOP to cancel, HELP for help\. Msg&data rates may apply\./);
});

test('buildMessageBody: custom per-client brand', () => {
  const body = buildMessageBody('Liberty Hall', 'Your ticket is ready.');
  assert.match(body, /^Liberty Hall: Your ticket is ready\./);
});
