// header-loader.js branding: the saved copy is tied to the venue, a failed
// request never saves the IndieTix default, and a logo that won't load is
// replaced (fresh branding, then the venue address's logo, then IndieTix).
// Runs the real static script in a vm with small fake browser objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../src/public/header-loader.js', import.meta.url), 'utf8');
const CACHE_KEY = 'client_branding_cache';
const LH_LOGO = 'venue-logos/M5E5N7KAHZA7Q/liberty-hall-logo.png';

function tokenFor(venue) {
  const payload = Buffer.from(JSON.stringify({ username: venue, dbName: venue, userType: 'client' })).toString('base64');
  return `x.${payload}.y`;
}

function load({ host = 'libertyhall.indietix.net', venue = 'M5E5N7KAHZA7Q', saved, api, site } = {}) {
  const store = new Map();
  if (venue) store.set('authToken', tokenFor(venue));
  if (saved !== undefined) store.set(CACHE_KEY, JSON.stringify(saved));
  const calls = [];
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const respond = (body, ok = true, status = 200) => ({ ok, status, statusText: '', json: async () => body });
  const fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/client/branding')) {
      if (!api || api.fail) return respond({}, false, api?.status || 401);
      return respond({ success: true, branding: api.branding });
    }
    if (url.includes('site.json')) return site ? respond(site) : respond({}, false, 403);
    throw new Error(`unexpected fetch ${url}`);
  };
  const window = {
    INDIETIX_API_URL: 'https://api.example',
    INDIETIX_VENUE_SITE_DOMAIN: 'indietix.net',
    location: { pathname: '/products.html', hostname: host, replace() {} },
  };
  const document = { readyState: 'complete', querySelectorAll: () => [], body: {}, getElementById: () => null };
  const context = { window, document, localStorage, fetch, atob: (s) => Buffer.from(s, 'base64').toString('binary'), console: { log() {}, warn() {}, error() {} } };
  vm.runInNewContext(SOURCE, context);
  return { HL: window.HeaderLoader, store, calls };
}

const LH_BRANDING = { webHeaderCompany: 'Liberty Hall', logoFile: LH_LOGO, theaterName: 'Liberty Hall', clientID: 'M5E5N7KAHZA7Q' };
const LH_SITE = { clientId: 'M5E5N7KAHZA7Q', venueName: 'Liberty Hall', logoFile: LH_LOGO };
const saved = (data, ageMs, venue = 'M5E5N7KAHZA7Q') => ({ data, timestamp: Date.now() - ageMs, ...(venue ? { venue } : {}) });

test('success is saved with the venue', async () => {
  const { HL, store } = load({ api: { branding: LH_BRANDING } });
  assert.equal((await HL.fetchBrandingConfig()).logoFile, LH_LOGO);
  assert.equal(JSON.parse(store.get(CACHE_KEY)).venue, 'M5E5N7KAHZA7Q');
});

test('a fresh saved copy is used without asking the API', async () => {
  const { HL, calls } = load({ saved: saved(LH_BRANDING, 60_000) });
  assert.equal((await HL.fetchBrandingConfig()).logoFile, LH_LOGO);
  assert.equal(calls.length, 0);
});

test('expired login with an old saved copy keeps the venue logo and saves nothing new', async () => {
  const old = saved(LH_BRANDING, 2 * 60 * 60 * 1000);
  const { HL, store } = load({ saved: old, api: { fail: true } });
  assert.equal((await HL.fetchBrandingConfig()).logoFile, LH_LOGO);
  assert.deepEqual(JSON.parse(store.get(CACHE_KEY)), old);
});

test('failure with nothing saved uses the venue address logo, never saved', async () => {
  const { HL, store } = load({ api: { fail: true }, site: LH_SITE });
  const branding = await HL.fetchBrandingConfig();
  assert.equal(branding.logoFile, LH_LOGO);
  assert.equal(branding.webHeaderCompany, 'Liberty Hall');
  assert.equal(store.has(CACHE_KEY), false);
});

test('failure on a plain address falls back to IndieTix without saving it', async () => {
  const { HL, store, calls } = load({ host: 'dyme6dznlnzgk.cloudfront.net', api: { fail: true } });
  assert.equal((await HL.fetchBrandingConfig()).logoFile, 'indieTixLogo.png');
  assert.equal(store.has(CACHE_KEY), false);
  assert.equal(calls.some((u) => u.includes('site.json')), false);
});

test("another venue's saved copy and pre-change copies (no venue) are ignored", async () => {
  for (const s of [saved({ ...LH_BRANDING, logoFile: 'other.png' }, 1000, 'OTHERVENUE'), saved({ webHeaderCompany: 'IndieTix', logoFile: 'indieTixLogo.png' }, 1000, null)]) {
    const { HL } = load({ saved: s, api: { branding: LH_BRANDING } });
    assert.equal((await HL.fetchBrandingConfig()).logoFile, LH_LOGO);
  }
});

test('an unsafe site.json logo path is refused', async () => {
  const { HL } = load({ api: { fail: true }, site: { ...LH_SITE, logoFile: '../../evil.png' } });
  assert.equal((await HL.fetchBrandingConfig()).logoFile, 'indieTixLogo.png');
});

function fakeLogo(src) {
  const img = { listeners: [], attr: src, getAttribute: () => src, addEventListener: (t, f) => img.listeners.push(f) };
  Object.defineProperty(img, 'src', { get: () => img.attr, set: (v) => { img.attr = v; } });
  return img;
}
const fire = async (img) => { for (const f of img.listeners) await f(); };

test('a deleted old logo is replaced by fresh branding, then the address logo, then IndieTix, then stops', async () => {
  const NEW = 'venue-logos/M5E5N7KAHZA7Q/new.png';
  const { HL } = load({ saved: saved({ ...LH_BRANDING, logoFile: 'venue-logos/M5E5N7KAHZA7Q/old.png' }, 1000), api: { branding: { ...LH_BRANDING, logoFile: NEW } }, site: { ...LH_SITE, logoFile: 'venue-logos/M5E5N7KAHZA7Q/site.png' } });
  const img = fakeLogo('venue-logos/M5E5N7KAHZA7Q/old.png');
  HL.watchHeaderLogo({ querySelector: () => img });
  await fire(img); assert.equal(img.src, NEW);
  await fire(img); assert.equal(img.src, 'venue-logos/M5E5N7KAHZA7Q/site.png');
  await fire(img); assert.equal(img.src, 'indieTixLogo.png');
  await fire(img); assert.equal(img.src, 'indieTixLogo.png');
});
