import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { handler } from '../src/index.mjs';

const sqsMock = mockClient(SQSClient);

let originalNodeEnv, originalQueueUrl;

beforeEach(() => {
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'mock-message-id' });
  originalNodeEnv = process.env.NODE_ENV;
  originalQueueUrl = process.env.WEBHOOK_QUEUE_URL;
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  process.env.WEBHOOK_QUEUE_URL = originalQueueUrl;
});

function apiGatewayEvent(overrides = {}) {
  return {
    body: JSON.stringify({ merchant_id: 'MERCHANT-1', type: 'order.created' }),
    headers: { 'X-Square-Signature': 'sig-abc123', 'Content-Type': 'application/json' },
    pathParameters: null,
    queryStringParameters: null,
    requestContext: { requestId: 'req-1' },
    ...overrides
  };
}

test('handler: standard non-FIFO queue -- forwards the full API Gateway event shape, returns 200 with the real messageId', async () => {
  process.env.NODE_ENV = 'production';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue';

  const result = await handler(apiGatewayEvent());

  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.messageId, 'mock-message-id');

  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  const sentMessage = JSON.parse(call.args[0].input.MessageBody);
  assert.ok(sentMessage.body.includes('MERCHANT-1'));
  assert.equal(sentMessage.headers['X-Square-Signature'], 'sig-abc123');
  assert.ok(sentMessage.receivedAt);
  assert.equal(call.args[0].input.MessageGroupId, undefined, 'non-FIFO queue should not set FIFO params');
});

test('handler: a FIFO queue URL sets MessageGroupId from the webhook body\'s merchant_id', async () => {
  process.env.NODE_ENV = 'production';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue.fifo';

  await handler(apiGatewayEvent());

  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  assert.equal(call.args[0].input.MessageGroupId, 'MERCHANT-1');
  assert.ok(call.args[0].input.MessageDeduplicationId.startsWith('sig-abc123-'));
});

test('handler: FIFO queue falls back to a shared group when merchant_id can\'t be parsed from the body (doesn\'t drop the message)', async () => {
  process.env.NODE_ENV = 'production';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue.fifo';

  const result = await handler(apiGatewayEvent({ body: 'not valid json {' }));

  assert.equal(result.statusCode, 200);
  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  assert.equal(call.args[0].input.MessageGroupId, 'unknown-merchant');
});

test('handler: reads the signature header case-insensitively (lowercase x-square-signature)', async () => {
  process.env.NODE_ENV = 'production';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue.fifo';

  await handler(apiGatewayEvent({ headers: { 'x-square-signature': 'lowercase-sig' } }));

  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  assert.ok(call.args[0].input.MessageDeduplicationId.startsWith('lowercase-sig-'));
});

test('handler: development mode wraps the raw event directly, skipping the headers/requestContext shape', async () => {
  process.env.NODE_ENV = 'development';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue';

  const devEvent = { merchant_id: 'DEV-MERCHANT', foo: 'bar' };
  const result = await handler(devEvent);

  assert.equal(result.statusCode, 200);
  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  const sentMessage = JSON.parse(call.args[0].input.MessageBody);
  assert.deepEqual(sentMessage.body, devEvent);
  assert.equal(sentMessage.headers, undefined, 'dev-mode message shape has no headers field at all');
});

test('handler: a stringified event is JSON-parsed before processing', async () => {
  process.env.NODE_ENV = 'production';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue';

  const event = apiGatewayEvent();
  const result = await handler(JSON.stringify(event));

  assert.equal(result.statusCode, 200);
  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  const sentMessage = JSON.parse(call.args[0].input.MessageBody);
  assert.equal(sentMessage.headers['X-Square-Signature'], 'sig-abc123');
});

test('handler: SQS failure still returns 200 to Square (never trigger a webhook retry), with a generic error message in production', async () => {
  process.env.NODE_ENV = 'production';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue';
  sqsMock.on(SendMessageCommand).rejects(new Error('SQS is down, secret internal detail'));

  const result = await handler(apiGatewayEvent());

  assert.equal(result.statusCode, 200, 'must never give Square a reason to retry');
  const body = JSON.parse(result.body);
  assert.equal(body.error, 'Internal error');
  assert.ok(!JSON.stringify(body).includes('secret internal detail'), 'production errors must not leak internals');
});

test('handler: in development mode, SQS failure surfaces the real error message', async () => {
  process.env.NODE_ENV = 'development';
  process.env.WEBHOOK_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789/webhook-queue';
  sqsMock.on(SendMessageCommand).rejects(new Error('SQS is down for debugging'));

  const result = await handler({ foo: 'bar' });

  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.error, 'SQS is down for debugging');
});

test('handler: a missing WEBHOOK_QUEUE_URL is caught and still returns 200, not a crash', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.WEBHOOK_QUEUE_URL;

  const result = await handler(apiGatewayEvent());
  assert.equal(result.statusCode, 200);
});
