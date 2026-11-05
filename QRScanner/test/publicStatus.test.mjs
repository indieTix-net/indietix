import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

// The public status page's API (PUBLIC STATUS PAGE in app.mjs): component
// states from the environment's error alarms, never the alarms themselves.

const cloudWatchMock = mockClient(CloudWatchClient);
let ctx;
let prefixCounter = 0;

before(async () => { ctx = await startTestServer(); });
after(async () => {
  delete process.env.STATUS_ALARM_PREFIX;
  cloudWatchMock.restore();
  await stopTestServer(ctx);
});

// A fresh prefix per test, since responses are cached per prefix for a minute
beforeEach(() => {
  cloudWatchMock.reset();
  process.env.STATUS_ALARM_PREFIX = `env${++prefixCounter}`;
});

const alarm = (suffix, state = 'OK') => ({
  AlarmName: `${process.env.STATUS_ALARM_PREFIX}-${suffix}`,
  StateValue: state,
  StateReason: 'Threshold Crossed: secret details',
  AlarmDescription: 'internal description'
});

const getStatus = () => ctx.request('GET', '/api/public/status');

test('GET /api/public/status: off when no alarm prefix is set', async () => {
  delete process.env.STATUS_ALARM_PREFIX;
  const { status, json } = await getStatus();
  assert.equal(status, 200);
  assert.deepEqual(json, { enabled: false });
  assert.equal(cloudWatchMock.calls().length, 0);
});

test('GET /api/public/status: all OK reads as operational, listing only components that have alarms', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [
    alarm('ticket-orders-crashed'), alarm('qrscanner-server-errors'), alarm('daily-box-office-report-crashed')
  ] });
  const { status, json } = await getStatus();
  assert.equal(status, 200);
  assert.equal(json.overall, 'operational');
  assert.deepEqual(json.components.map(c => c.name), ['Ticket sales and delivery', 'Box office pages and door scanning', 'Nightly box-office reports']);
  assert.ok(json.components.every(c => c.status === 'operational'));
  assert.equal(cloudWatchMock.commandCalls(DescribeAlarmsCommand)[0].args[0].input.AlarmNamePrefix, `${process.env.STATUS_ALARM_PREFIX}-`);
});

test('GET /api/public/status: an alarm in ALARM marks its component and the overall status as a problem', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [
    alarm('ticket-orders-stuck-in-queue', 'ALARM'), alarm('qrscanner-crashed')
  ] });
  const { json } = await getStatus();
  assert.equal(json.overall, 'problem');
  assert.deepEqual(json.components, [
    { name: 'Ticket sales and delivery', status: 'problem' },
    { name: 'Box office pages and door scanning', status: 'operational' }
  ]);
});

test('GET /api/public/status: never exposes alarm names, reasons or descriptions', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [alarm('qrscanner-crashed', 'ALARM')] });
  const { text } = await getStatus();
  assert.doesNotMatch(text, /qrscanner-crashed|secret details|internal description|env\d+/);
});

test('GET /api/public/status: the logged-errors alarm alone does not show a public problem', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [
    alarm('ticket-orders-logged-errors', 'ALARM'), alarm('ticket-orders-crashed')
  ] });
  const { json } = await getStatus();
  assert.equal(json.overall, 'operational');
});

test('GET /api/public/status: follows CloudWatch pages', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand)
    .resolvesOnce({ MetricAlarms: [alarm('qrscanner-crashed')], NextToken: 'page2' })
    .resolvesOnce({ MetricAlarms: [alarm('inbound-sms-crashed', 'ALARM')] });
  const { json } = await getStatus();
  assert.equal(cloudWatchMock.commandCalls(DescribeAlarmsCommand).length, 2);
  assert.deepEqual(json.components.find(c => c.name === 'Text messages'), { name: 'Text messages', status: 'problem' });
});

test('GET /api/public/status: cached for a minute', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [alarm('qrscanner-crashed')] });
  await getStatus();
  await getStatus();
  assert.equal(cloudWatchMock.commandCalls(DescribeAlarmsCommand).length, 1);
});

test('GET /api/public/status: a CloudWatch failure is a 503 with no details', async () => {
  cloudWatchMock.on(DescribeAlarmsCommand).rejects(new Error('AccessDenied: not authorized on arn:aws:cloudwatch:...'));
  const { status, json, text } = await getStatus();
  assert.equal(status, 503);
  assert.equal(json.message, 'Status is unavailable right now');
  assert.doesNotMatch(text, /AccessDenied|arn:/);
});
