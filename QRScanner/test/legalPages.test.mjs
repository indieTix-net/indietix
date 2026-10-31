import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';
import { LEGAL_PAGES, LEGAL_KEYS, LEGAL_DEFAULTS, renderLegalPage, legalValues } from '../src/utils/legal.mjs';

// A made-up venue (not any real one), with characters that need escaping.
const VENUE = {
  LEGAL_NAME: 'Example Cinema & Bar Inc.',
  LEGAL_SHORT_NAME: 'Example Cinema',
  LEGAL_ADDRESS: '12 Main Street, Springfield, ST 12345',
  LEGAL_PHONE: '555-0100',
  LEGAL_EMAIL: 'legal@example.com',
  LEGAL_STATE: 'Ohio',
  LEGAL_COURT_COUNTY: 'Franklin County, Ohio',
  STATIC_WEBSITE_URL: 'https://site.example.com/'
};

let ctx;

before(async () => { ctx = await startTestServer({ clientConfig: VENUE }); });
after(async () => { await stopTestServer(ctx); });

// ---- renderer ----

test('legal pages: the committed static pages are the renderer output with the placeholders (npm run render-legal)', () => {
  for (const page of LEGAL_PAGES) {
    const committed = readFileSync(new URL(`../src/public/${page}.html`, import.meta.url), 'utf8');
    assert.equal(committed, renderLegalPage(page), `src/public/${page}.html is out of date -- run npm run render-legal`);
  }
});

test('legal pages: templates name no real venue, and every placeholder gets filled', () => {
  for (const page of LEGAL_PAGES) {
    const template = readFileSync(new URL(`../src/legal/${page}.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(template, /Liberty Hall|Lawrence|Kansas|Massachusetts|785-/);
    assert.doesNotMatch(renderLegalPage(page, VENUE), /\{\{/);
  }
});

test('legal pages: a venue\'s values are used, and HTML in them is escaped', () => {
  const html = renderLegalPage('terms', { ...VENUE, LEGAL_NAME: 'Evil <script>alert(1)</script> Inc.' });
  assert.match(html, /Evil &lt;script&gt;alert\(1\)&lt;\/script&gt; Inc\./);
  assert.doesNotMatch(html, /<script>alert/);
  const privacy = renderLegalPage('privacy', VENUE);
  assert.match(privacy, /Example Cinema &amp; Bar Inc\., 12 Main Street, Springfield, ST 12345/);
  assert.match(privacy, /mailto:legal@example\.com/);
  assert.match(renderLegalPage('terms', VENUE), /laws of the State of Ohio/);
  assert.match(renderLegalPage('terms', VENUE), /courts located in Franklin County, Ohio/);
});

test('legal pages: blank settings show placeholders; a set LEGAL_NAME also stands in for a blank short name', () => {
  assert.deepEqual(legalValues({}), LEGAL_DEFAULTS);
  assert.equal(legalValues({ LEGAL_NAME: '  Solo Theatre LLC  ' }).LEGAL_SHORT_NAME, 'Solo Theatre LLC');
  assert.equal(legalValues({ LEGAL_EMAIL: '' }).LEGAL_EMAIL, 'privacy@indietix.net');
  assert.deepEqual(Object.keys(LEGAL_DEFAULTS).sort(), [...LEGAL_KEYS].sort());
});

// ---- GET /legal/:page ----

test('GET /legal/privacy?client=: the venue\'s page as HTML, linking to its own terms page', async () => {
  const { status, text, headers } = await ctx.request('GET', `/legal/privacy?client=${ctx.clientId}`);
  assert.equal(status, 200);
  assert.match(headers.get('content-type'), /text\/html/);
  assert.match(text, /<title>Privacy Policy · Example Cinema<\/title>/);
  assert.match(text, new RegExp(`href="terms\\?client=${ctx.clientId}"`));
  assert.match(text, /href="https:\/\/site\.example\.com\/oxblood-theme\.css"/);
});

test('GET /legal/terms?client=&links=static: relative links, as the plain static page needs', async () => {
  const { status, text } = await ctx.request('GET', `/legal/terms.html?client=${ctx.clientId}&links=static`);
  assert.equal(status, 200);
  assert.equal(text, renderLegalPage('terms', VENUE));
  assert.match(text, /href="privacy\.html"/);
});

test('GET /legal: bad page, bad client and unknown client are refused', async () => {
  assert.equal((await ctx.request('GET', `/legal/cookies?client=${ctx.clientId}`)).status, 404);
  assert.equal((await ctx.request('GET', '/legal/privacy')).status, 400);
  assert.equal((await ctx.request('GET', '/legal/privacy?client=bad-id!')).status, 400);
  assert.equal((await ctx.request('GET', '/legal/privacy?client=NOSUCHCLIENT999')).status, 404);
});

test('Client Settings: LEGAL_* keys can be saved', async () => {
  const { status, json } = await ctx.request('PUT', '/api/client', {
    token: ctx.clientToken,
    body: { contactName: 'Test Contact', clientEmail: 'contact@example.com', configuration: { LEGAL_PHONE: '555-0199' } }
  });
  assert.equal(status, 200);
  assert.deepEqual(json.ignoredKeys || [], []);
  const page = await ctx.request('GET', `/legal/privacy?client=${ctx.clientId}`);
  assert.match(page.text, /555-0199/);
});
