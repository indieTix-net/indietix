import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Every page calls the API at config.js's INDIETIX_API_URL, so each
// environment reaches its own API through its own firewall. A hard-coded
// Function URL (production's forgot/reset password pages had one) skips the
// firewall, breaks once the direct address is closed, and points every other
// environment at production.
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public');
const pages = fs.readdirSync(PUBLIC).filter(f => /\.(html|js)$/.test(f) && f !== 'config.js');

test('no static page hard-codes an API address', () => {
  for (const file of pages) {
    const text = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.doesNotMatch(text, /lambda-url\.[a-z0-9-]+\.on\.aws|execute-api\.[a-z0-9-]+\.amazonaws\.com/, file);
  }
});

test('the password pages load config.js and call the API through it', () => {
  for (const file of ['forgot-password.html', 'reset-password.html']) {
    const text = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.match(text, /<script src="config\.js"><\/script>/, file);
    assert.match(text, /\$\{window\.INDIETIX_API_URL\}\/api\/(forgot|reset)-password/, file);
  }
});
