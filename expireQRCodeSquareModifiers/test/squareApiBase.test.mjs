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
  assert.match(source, /from 'square-api-lib'/);
});

test('SQUARE_API_BASE set to the sandbox sends catalog calls there (trailing slash trimmed)', async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ object: { id: 'OBJ1' } }), text: async () => '{}' };
  };
  process.env.SQUARE_API_BASE = 'https://connect.squareupsandbox.com/';
  try {
    // A fresh copy of the module, so it reads the setting at load time.
    const mod = await import('../src/index.mjs?square-sandbox');
    await mod.retrieveCatalogObject('OBJ1');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SQUARE_API_BASE;
  }
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/connect\.squareupsandbox\.com\/v2\/catalog\/object\/OBJ1/);
});
