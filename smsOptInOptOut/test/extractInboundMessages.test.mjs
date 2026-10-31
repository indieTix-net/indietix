import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractInboundMessages } from '../src/index.mjs';

const samplePayload = { originationNumber: '+19135551234', destinationNumber: '+19135550000', messageKeyword: 'STOP' };

test('extractInboundMessages: SNS Records format', () => {
  const event = { Records: [{ Sns: { Message: JSON.stringify(samplePayload) } }] };
  const messages = extractInboundMessages(event);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], samplePayload);
});

test('extractInboundMessages: SQS wrapping an SNS envelope', () => {
  const sqsBody = JSON.stringify({ Message: JSON.stringify(samplePayload) });
  const event = { Records: [{ body: sqsBody }] };
  const messages = extractInboundMessages(event);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], samplePayload);
});

test('extractInboundMessages: raw SQS body (no SNS envelope)', () => {
  const event = { Records: [{ body: JSON.stringify(samplePayload) }] };
  const messages = extractInboundMessages(event);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], samplePayload);
});

test('extractInboundMessages: direct Pinpoint invocation (no Records wrapper)', () => {
  const messages = extractInboundMessages(samplePayload);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], samplePayload);
});

test('extractInboundMessages: multiple records in one batch', () => {
  const second = { ...samplePayload, originationNumber: '+19135559999' };
  const event = {
    Records: [
      { Sns: { Message: JSON.stringify(samplePayload) } },
      { Sns: { Message: JSON.stringify(second) } }
    ]
  };
  const messages = extractInboundMessages(event);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].originationNumber, '+19135559999');
});

test('extractInboundMessages: malformed JSON in a record is skipped, not thrown', () => {
  const event = { Records: [{ Sns: { Message: 'not valid json {' } }] };
  const messages = extractInboundMessages(event);
  assert.equal(messages.length, 0);
});

test('extractInboundMessages: one bad record among good ones doesn\'t drop the good ones', () => {
  const event = {
    Records: [
      { Sns: { Message: 'not valid json {' } },
      { Sns: { Message: JSON.stringify(samplePayload) } }
    ]
  };
  const messages = extractInboundMessages(event);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], samplePayload);
});

test('extractInboundMessages: unrecognized event shape returns an empty array', () => {
  assert.deepEqual(extractInboundMessages({}), []);
  assert.deepEqual(extractInboundMessages({ foo: 'bar' }), []);
});
