import { test } from 'node:test';
import assert from 'node:assert/strict';

// CLIENT_IDS_OVERRIDE is captured from process.env.CLIENT_IDS at module
// load time (a top-level const in src/index.mjs), so it has to be set
// BEFORE importing the module. node --test runs each test file in its
// own process, so this doesn't leak into any other test file.
process.env.CLIENT_IDS = 'M5E5N7KAHZA7Q, ABCDEFGHIJKLM ,  ';

const { discoverClientIds } = await import('../src/index.mjs');

test('discoverClientIds: CLIENT_IDS env override skips Secrets Manager discovery entirely', async () => {
  const ids = await discoverClientIds();
  assert.deepEqual(ids, ['M5E5N7KAHZA7Q', 'ABCDEFGHIJKLM']);
});
