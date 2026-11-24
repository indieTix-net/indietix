import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Every Square call goes through the shared square-api-lib, which reads
// SQUARE_API_BASE so an environment can be pointed at Square's sandbox (that
// package's own tests check the production default). So no Square address
// may be hard-coded here at all.
test('src/index.mjs: no hard-coded Square address; Square calls go through square-api-lib', async () => {
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const hits = source.split('\n').filter((line) => /connect\.squareup(sandbox)?\.com/.test(line) && !line.trim().startsWith('//'));
  assert.deepEqual(hits, []);
  assert.doesNotMatch(source, /process\.env\.SQUARE_API_BASE/);
  assert.match(source, /from 'square-api-lib'/);
});
