import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { build, readGuide, slug, GUIDE_DIR } from '../build.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `help-${name}-`));

test('the real guide builds: a page per guide file, the index, search and every image', () => {
  const out = tmp('real');
  const written = build(out);
  const pages = readGuide();
  assert.ok(pages.length >= 10);
  for (const p of pages) assert.ok(written.includes(`${p.name}.html`), p.name);
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  for (const p of pages) assert.ok(index.includes(`href="${p.name}.html"`), `index links ${p.name}`);
  for (const img of fs.readdirSync(path.join(GUIDE_DIR, 'images'))) {
    const used = pages.some(p => p.markdown.includes(`images/${img}`));
    assert.ok(used, `images/${img} isn't used by any page (remove it or use it)`);
    assert.ok(fs.existsSync(path.join(out, 'images', img)), `copied ${img}`);
  }
  const search = fs.readFileSync(path.join(out, 'search-index.js'), 'utf8');
  assert.match(search, /^window\.HELP_INDEX = \[/);
  assert.match(search, /Refund an order/);
});

test('guide pages link to each other as .html, with GitHub-style section anchors', () => {
  const out = tmp('links');
  build(out);
  const html = fs.readFileSync(path.join(out, '12-troubleshooting.html'), 'utf8');
  assert.match(html, /href="04-adding-movies-and-events\.html#how-a-ticket-item-is-built-in-square"/);
  const target = fs.readFileSync(path.join(out, '04-adding-movies-and-events.html'), 'utf8');
  assert.match(target, /id="how-a-ticket-item-is-built-in-square"/);
  assert.equal(slug("Today's Dashboard"), 'todays-dashboard');
  assert.equal(slug('Skeleton keys (comps and re-entry)'), 'skeleton-keys-comps-and-re-entry');
});

test('nothing in the guide states a price (pricing lives on indietix.net)', () => {
  for (const p of readGuide()) {
    const prices = p.markdown.match(/\$\d+(\.\d\d)?\s*(\/|a |per )\s*(mo|month)/gi);
    assert.equal(prices, null, `${p.file}: ${prices}`);
  }
});

test('a broken link, section or image stops the build', () => {
  const guide = tmp('guide');
  fs.mkdirSync(path.join(guide, 'images'));
  fs.writeFileSync(path.join(guide, '01-one.md'), '# One\n\nIntro.\n\n## Part A\n\nSee [two](02-two.md) and [missing](03-gone.md).\n');
  fs.writeFileSync(path.join(guide, '02-two.md'), '# Two\n\nIntro.\n\n[bad section](01-one.md#part-b)\n\n![shot](images/nope.webp)\n');
  assert.throws(() => build(tmp('out'), guide), (e) =>
    /missing page 03-gone\.md/.test(e.message) && /missing section 01-one\.md#part-b/.test(e.message) && /missing image images\/nope\.webp/.test(e.message));
});

test('every page needs a title and a one-line intro', () => {
  const guide = tmp('nointro');
  fs.writeFileSync(path.join(guide, '01-one.md'), '# One\n\n## Straight to a section\n');
  assert.throws(() => build(tmp('out'), guide), /needs a one-line intro/);
});
