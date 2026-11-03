import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { deleteVenueLogos } from '../src/index.js';

// Teardown removes the venue's uploaded logos from the environment's shared
// static site: only venue-logos/<id>/, never anything else. Stubbed S3: no
// network, no AWS credentials.
const originalSend = S3Client.prototype.send;
let calls;
let pages;

beforeEach(() => {
  process.env.STATIC_SITE_BUCKET = 'env-qrscanner-static-site';
  calls = [];
  pages = [];
  S3Client.prototype.send = async function (command) {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (name === 'ListObjectsV2Command') return pages.shift() || { Contents: [] };
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

test("deleteVenueLogos: lists only the venue's folder and deletes what's there", async () => {
  pages = [{ Contents: [{ Key: 'venue-logos/VENUE1/logo-a.png' }, { Key: 'venue-logos/VENUE1/logo-b.png' }] }];
  assert.equal(await deleteVenueLogos('VENUE1'), 2);
  const list = calls.find(c => c.name === 'ListObjectsV2Command');
  assert.equal(list.input.Bucket, 'env-qrscanner-static-site');
  assert.equal(list.input.Prefix, 'venue-logos/VENUE1/');
  assert.deepEqual(deletedKeys(), ['venue-logos/VENUE1/logo-a.png', 'venue-logos/VENUE1/logo-b.png']);
});

test('deleteVenueLogos: follows every page of the listing', async () => {
  pages = [
    { Contents: [{ Key: 'venue-logos/VENUE1/logo-a.png' }], IsTruncated: true, NextContinuationToken: 'PAGE2' },
    { Contents: [{ Key: 'venue-logos/VENUE1/logo-b.png' }] }
  ];
  assert.equal(await deleteVenueLogos('VENUE1'), 2);
  assert.equal(calls.filter(c => c.name === 'ListObjectsV2Command')[1].input.ContinuationToken, 'PAGE2');
});

test("deleteVenueLogos: never deletes another venue's file, even if the listing returns one", async () => {
  pages = [{ Contents: [{ Key: 'venue-logos/VENUE10/logo-x.png' }, { Key: 'venue-logos/VENUE1/logo-a.png' }] }];
  assert.equal(await deleteVenueLogos('VENUE1'), 1);
  assert.deepEqual(deletedKeys(), ['venue-logos/VENUE1/logo-a.png']);
});

test('deleteVenueLogos: no logos is fine', async () => {
  assert.equal(await deleteVenueLogos('VENUE1'), 0);
  assert.equal(deletedKeys().length, 0);
});

test('deleteVenueLogos: does nothing when the site has no logo bucket', async () => {
  delete process.env.STATIC_SITE_BUCKET;
  assert.equal(await deleteVenueLogos('VENUE1'), 'off');
  assert.equal(calls.length, 0);
});

test('deleteVenueLogos: an S3 error is reported, not thrown', async () => {
  S3Client.prototype.send = async () => { throw new Error('Access Denied'); };
  assert.equal(await deleteVenueLogos('VENUE1'), false);
});
