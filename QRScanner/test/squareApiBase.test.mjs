import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Every Square call goes through SQUARE_API_BASE, so an environment can be
// pointed at Square's sandbox. The production address may appear only once:
// as that setting's default.
test('src/app.mjs: Square API calls use SQUARE_API_BASE, with production only as the default', async () => {
  const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  const hits = source.split('\n').filter((line) => line.includes('connect.squareup.com'));
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /process\.env\.SQUARE_API_BASE \|\| 'https:\/\/connect\.squareup\.com'/);
});
