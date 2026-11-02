import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDeliveryAlert, sendDeliveryAlert } = require('../src/index.js');

const sesMock = mockClient(SESClient);
beforeEach(() => { sesMock.reset(); sesMock.on(SendRawEmailCommand).resolves({ MessageId: 'm1' }); });

const venue = {
  clientId: 'M5E5N7KAHZA7Q',
  contactEmail: 'owner@example.com',
  configuration: { THEATER_NAME: 'Test Cinema', SENDER_EMAIL: 'tickets@example.com', OWNER_BCC_EMAIL: 'owner@example.com' }
};
const failed = { success: true, deliveryFailures: ['FTP1 (EBOR) FRG_1_202611010000.xml: 530 Login incorrect.'] };

test('buildDeliveryAlert: no failures, no alert', () => {
  assert.equal(buildDeliveryAlert(venue, { success: true, deliveryFailures: [] }, '2026-11-01'), null);
});

test('buildDeliveryAlert: names the venue, date and each failure; contact and OWNER_BCC_EMAIL deduplicated', () => {
  const alert = buildDeliveryAlert(venue, failed, '2026-11-01');
  assert.equal(alert.from, 'tickets@example.com');
  assert.deepEqual(alert.to, ['owner@example.com']);
  assert.match(alert.subject, /delivery failed for Test Cinema \(2026-11-01\)/);
  assert.match(alert.text, /FTP1 \(EBOR\) .*530 Login incorrect/);
});

test('buildDeliveryAlert: newlines in config values cannot add email headers', () => {
  const alert = buildDeliveryAlert(
    { ...venue, configuration: { ...venue.configuration, THEATER_NAME: 'X\r\nBcc: evil@example.com' } }, failed, '2026-11-01');
  assert.doesNotMatch(alert.subject, /[\r\n]/);
});

test('buildDeliveryAlert: without a sender or a recipient it is marked skipped, not sent', () => {
  const noSender = buildDeliveryAlert({ ...venue, configuration: { THEATER_NAME: 'T' } }, failed, '2026-11-01');
  assert.match(noSender.skipped, /SENDER_EMAIL/);
  const noTo = buildDeliveryAlert({ clientId: 'c', contactEmail: null, configuration: { SENDER_EMAIL: 's@example.com' } }, failed, '2026-11-01');
  assert.match(noTo.skipped, /contact email/);
});

test('buildDeliveryAlert: test mode builds an alert with no failures', () => {
  const alert = buildDeliveryAlert(venue, null, '2026-11-01', { test: true });
  assert.match(alert.subject, /test alert/);
});

test('sendDeliveryAlert: sends one raw email from SENDER_EMAIL to the recipients', async () => {
  const sent = await sendDeliveryAlert(buildDeliveryAlert(venue, failed, '2026-11-01'));
  assert.deepEqual(sent, { clientId: 'M5E5N7KAHZA7Q', sent: true });
  const calls = sesMock.commandCalls(SendRawEmailCommand);
  assert.equal(calls.length, 1);
  const input = calls[0].args[0].input;
  assert.equal(input.Source, 'tickets@example.com');
  assert.deepEqual(input.Destinations, ['owner@example.com']);
  const raw = Buffer.from(input.RawMessage.Data).toString('utf8');
  assert.match(raw, /^From: tickets@example\.com\r\nTo: owner@example\.com\r\nSubject: /);
  assert.match(raw, /530 Login incorrect/);
});

test('sendDeliveryAlert: an SES error is reported, never thrown (the run must not fail and be retried)', async () => {
  sesMock.on(SendRawEmailCommand).rejects(new Error('Email address is not verified'));
  const sent = await sendDeliveryAlert(buildDeliveryAlert(venue, failed, '2026-11-01'));
  assert.equal(sent.sent, false);
  assert.match(sent.reason, /not verified/);
});

test('sendDeliveryAlert: a skipped alert sends nothing', async () => {
  const sent = await sendDeliveryAlert({ clientId: 'c', skipped: 'no SENDER_EMAIL to send the alert' });
  assert.equal(sent.sent, false);
  assert.equal(sesMock.commandCalls(SendRawEmailCommand).length, 0);
});
