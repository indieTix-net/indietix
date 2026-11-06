import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { deleteVenueSite } from '../src/index.js';

// Teardown frees the venue's own web address (venue-sites/<name>/ on the
// shared static site), but only when that folder's site.json names this
// venue. Stubbed S3: no network, no AWS credentials.
const originalSend = S3Client.prototype.send;
let calls;
let owner;
let listing;

beforeEach(() => {
  process.env.STATIC_SITE_BUCKET = 'env-qrscanner-static-site';
  calls = [];
  owner = 'VENUE1';
  listing = { Contents: [
    { Key: 'venue-sites/thunderbeaver/site.json' },
    { Key: 'venue-sites/thunderbeaver/privacy.html' },
    { Key: 'venue-sites/thunderbeaver/terms.html' }
  ] };
  S3Client.prototype.send = async function (command) {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (name === 'GetObjectCommand') {
      if (owner === null) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => JSON.stringify({ clientId: owner }) } };
    }
    if (name === 'ListObjectsV2Command') return listing;
    return {};
  };
});
afterEach(() => {
  S3Client.prototype.send = originalSend;
  delete process.env.STATIC_SITE_BUCKET;
});

const deletedKeys = () => calls
  .filter(c => c.name === 'DeleteObjectsCommand')
  .flatMap(c => c.input.Delete.Objects.map(o => o.Key));

test("deleteVenueSite: deletes the venue's own address folder", async () => {
  assert.equal(await deleteVenueSite('VENUE1', 'thunderbeaver'), 3);
  assert.equal(calls.find(c => c.name === 'GetObjectCommand').input.Key, 'venue-sites/thunderbeaver/site.json');
  assert.equal(calls.find(c => c.name === 'ListObjectsV2Command').input.Prefix, 'venue-sites/thunderbeaver/');
  assert.deepEqual(deletedKeys(), listing.Contents.map(o => o.Key));
});

test("deleteVenueSite: never touches an address another venue owns", async () => {
  owner = 'VENUE2';
  assert.equal(await deleteVenueSite('VENUE1', 'thunderbeaver'), 'none');
  assert.equal(deletedKeys().length, 0);
});

test('deleteVenueSite: no address, an invalid name, or an already-free name is fine', async () => {
  assert.equal(await deleteVenueSite('VENUE1', null), 'none');
  assert.equal(await deleteVenueSite('VENUE1', '../venue-logos'), 'none');
  assert.equal(calls.length, 0);
  owner = null;
  assert.equal(await deleteVenueSite('VENUE1', 'thunderbeaver'), 'none');
  assert.equal(deletedKeys().length, 0);
});

test('deleteVenueSite: does nothing when the site has no static bucket', async () => {
  delete process.env.STATIC_SITE_BUCKET;
  assert.equal(await deleteVenueSite('VENUE1', 'thunderbeaver'), 'off');
  assert.equal(calls.length, 0);
});

test('deleteVenueSite: an S3 error is reported, not thrown', async () => {
  S3Client.prototype.send = async () => { throw new Error('Access Denied'); };
  assert.equal(await deleteVenueSite('VENUE1', 'thunderbeaver'), false);
});
