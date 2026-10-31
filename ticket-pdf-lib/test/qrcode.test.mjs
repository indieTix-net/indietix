import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQRCode } from '../src/qrcode.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('generateQRCode returns a valid PNG buffer for a typical ticket code', async () => {
  const buf = await generateQRCode('MOVIE_ADULT_abc123_uid1_0_1792800000000');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
  assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC);
});

test('generateQRCode produces different output for different input', async () => {
  const bufA = await generateQRCode('ticket-aaa');
  const bufB = await generateQRCode('ticket-bbb');
  assert.notDeepEqual(bufA, bufB);
});

test('generateQRCode handles a long (but realistic) composite ticket code', async () => {
  const longCode = 'Some Long Movie Title (2026)_Adult_sq0orderId123456789_lineItemUid987654321_3_1792800000000';
  const buf = await generateQRCode(longCode);
  assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC);
});

test('generateQRCode rejects empty input the same way the underlying qrcode lib does', async () => {
  await assert.rejects(() => generateQRCode(''));
});
