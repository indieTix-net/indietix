import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3Buckets } from '../src/index.js';

// Stub every S3 call: record the command names, and let a test decide how
// CreateBucket answers. No network, no AWS credentials.
const originalSend = S3Client.prototype.send;
let calls;
let createBucketError;

beforeEach(() => {
  calls = [];
  createBucketError = null;
  S3Client.prototype.send = async function (command) {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (name === 'CreateBucketCommand' && createBucketError) throw createBucketError;
    return {};
  };
});
afterEach(() => { S3Client.prototype.send = originalSend; });

const names = () => calls.map(c => c.name);

test('createS3Buckets: a new bucket gets settings, templates and folders', async () => {
  await createS3Buckets('ABC123', 'env-');
  assert.ok(names().includes('PutPublicAccessBlockCommand'));
  assert.ok(names().includes('PutBucketPolicyCommand'));
  assert.ok(names().includes('PutBucketCorsCommand'));
  assert.equal(calls.filter(c => c.name === 'CopyObjectCommand').length, 2);
});

test('createS3Buckets: a bucket that already exists still gets templates and folders, but keeps its own settings', async () => {
  createBucketError = Object.assign(new Error('Your previous request to create the named bucket succeeded'), { name: 'BucketAlreadyOwnedByYou' });
  const results = await createS3Buckets('ABC123', 'env-');

  const copies = calls.filter(c => c.name === 'CopyObjectCommand');
  assert.deepEqual(copies.map(c => c.input.Key).sort(), ['ticket_horizontal.pdf', 'ticket_vertical.pdf']);
  assert.ok(copies.every(c => c.input.Bucket === 'env-abc123'));
  assert.ok(calls.some(c => c.name === 'PutObjectCommand' && c.input.Key === 'tickets-out/'));
  assert.ok(!names().includes('PutPublicAccessBlockCommand'));
  assert.ok(!names().includes('PutBucketPolicyCommand'));
  assert.ok(!names().includes('PutBucketCorsCommand'));
  assert.ok(results.some(r => r.bucket === 'env-abc123' && r.action === 'already_exists' && r.success));
});

test('createS3Buckets: any other create error still skips setup', async () => {
  createBucketError = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
  await createS3Buckets('ABC123', 'env-');
  assert.ok(!names().includes('CopyObjectCommand'));
});

// Hosted signup creates the bucket here (no bootstrap client-buckets stack),
// and the browser uploads custom posters straight to it, so its CORS has to
// name the venue's own site, not another deployment's.
const corsOrigins = () => calls.find(c => c.name === 'PutBucketCorsCommand').input.CORSConfiguration.CORSRules[0].AllowedOrigins;

test("createS3Buckets: a new bucket's CORS allows the venue's own site", async () => {
  await createS3Buckets('ABC123', 'env-', 'https://d111example.cloudfront.net/');
  assert.equal(corsOrigins()[0], 'https://d111example.cloudfront.net');
  assert.ok(!corsOrigins().includes('https://dyme6dznlnzgk.cloudfront.net'));
});

test('createS3Buckets: with no site URL the CORS default is unchanged', async () => {
  await createS3Buckets('ABC123', 'env-');
  assert.equal(corsOrigins()[0], 'https://dyme6dznlnzgk.cloudfront.net');
});

test('createS3Buckets: an unparseable site URL falls back to the default', async () => {
  await createS3Buckets('ABC123', 'env-', 'not a url');
  assert.equal(corsOrigins()[0], 'https://dyme6dznlnzgk.cloudfront.net');
});
