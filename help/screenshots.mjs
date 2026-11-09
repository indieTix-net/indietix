// Takes the guide's screenshots from the demo venue (made-up data only, see
// demo-data/), using the Chrome installed on this computer. Saves them to
// support/knowledge/images/, where the guide pages point.
//
//   HELP_GUEST_PASSWORD=... HELP_VENUE_SECRET=... node screenshots.mjs [name ...]
//
// HELP_SITE (default the indietix-boottest site) and HELP_CLIENT (default
// marquee) pick the demo venue. The guest login takes the staff pages; the
// venue's main login takes the main-login-only pages. Give names to retake
// only those shots. CHROME_PATH overrides where Chrome is.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'support', 'knowledge', 'images');
const SITE = (process.env.HELP_SITE || 'https://dplcdwxautrmn.cloudfront.net').replace(/\/$/, '');
const CLIENT = process.env.HELP_CLIENT || 'marquee';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOGINS = {
  guest: { username: 'guest', password: process.env.HELP_GUEST_PASSWORD },
  venue: { username: CLIENT, password: process.env.HELP_VENUE_SECRET }
};

const settle = (page) => page.waitForNetworkIdle({ idleTime: 800, timeout: 12000 }).catch(() => {});
const pause = (ms) => new Promise(r => setTimeout(r, ms));
async function clickText(page, text, selector = 'button') {
  const el = await page.waitForSelector(`${selector}::-p-text(${text})`, { visible: true, timeout: 15000 });
  await el.click();
  await pause(700);
}
// The settings section whose heading is `text` (heading up to the next
// section's divider), for an element screenshot.
async function sectionUnder(page, text) {
  await page.waitForFunction((t) => [...document.querySelectorAll('h4')].some(x => x.textContent.trim() === t && x.offsetParent), { timeout: 20000 }, text);
  return page.evaluateHandle((t) => {
    const h = [...document.querySelectorAll('h4')].find(x => x.textContent.trim() === t);
    let el = h;
    while (el.parentElement && el.parentElement.querySelectorAll('h4').length === 1) el = el.parentElement;
    return el;
  }, text);
}
async function allDates(page) {
  await page.click('#clear-date-filter');
  await settle(page);
}
// The tables also render as phone cards (hidden on a wide screen), so use the
// first Actions button that's actually visible.
async function openFirstActions(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.action-dropdown-btn')].some(b => b.offsetParent), { timeout: 20000 });
  const buttons = await page.$$('.action-dropdown-btn');
  for (const b of buttons) {
    if (await b.evaluate(el => Boolean(el.offsetParent))) {
      await b.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await b.click();
      break;
    }
  }
  await pause(600);
}

// name -> how to get there. Names match the images the guide uses.
const SHOTS = [
  { name: 'login', login: null, url: '/login.html', before: async (p) => {
    await p.evaluate((c) => { document.querySelector('#clientId').value = c; document.querySelector('#username').value = 'guest'; }, CLIENT);
  } },
  { name: 'dashboard', login: 'guest', url: '/dashboard.html', keepHeader: true },
  { name: 'scanner', login: 'guest', url: '/', wait: 2500 },
  // The tickets page opens on today, which can be a day with no shows: show all dates.
  { name: 'tickets', login: 'guest', url: '/products.html', before: allDates },
  { name: 'ticket-actions', login: 'guest', url: '/products.html', before: async (p) => { await allDates(p); await openFirstActions(p); } },
  { name: 'orders', login: 'guest', url: '/order.html' },
  { name: 'order-actions', login: 'guest', url: '/order.html', before: openFirstActions },
  { name: 'refund-dialog', login: 'guest', url: '/order.html', before: async (p) => {
    await openFirstActions(p);
    await p.evaluate(() => [...document.querySelectorAll('.action-refund')].find(b => b.offsetParent)?.click());
    await p.waitForSelector('.modal.show', { visible: true, timeout: 15000 });
    await settle(p);
  } },
  { name: 'event-report', login: 'guest', url: '/reports.html', before: async (p) => {
    await p.select('select', 'Event').catch(() => {});
    await clickText(p, 'Add').catch(() => {});
    await settle(p);
  } },
  { name: 'insights', login: 'venue', url: '/insights.html' },
  { name: 'movie-lookup', login: 'venue', url: '/getMovieInfo.html' },
  { name: 'event-entry', login: 'venue', url: '/getEventInfo.html' },
  { name: 'marketing', login: 'venue', url: '/marketing.html' },
  { name: 'user-management', login: 'venue', url: '/user-management.html' },
  { name: 'create-user', login: 'venue', url: '/user-management.html', before: async (p) => { await clickText(p, 'Create New User'); } },
  { name: 'client-settings', login: 'venue', url: '/client.html' },
  { name: 'ticket-items-settings', login: 'venue', url: '/client.html', element: (p) => sectionUnder(p, 'Square Ticket Items') },
  { name: 'privacy-requests', login: 'venue', url: '/privacy-requests.html' },
  { name: 'status', login: null, url: '/status.html' }
];

// Logs in through the API (the address is in the site's config.js) and gives
// a fresh browser context the token, the way the login page stores it.
async function logIn(browser, who) {
  const config = await (await fetch(`${SITE}/config.js`)).text();
  const api = (config.match(/INDIETIX_API_URL\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  if (!api) throw new Error(`no INDIETIX_API_URL in ${SITE}/config.js`);
  const res = await fetch(`${api.replace(/\/$/, '')}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT, username: LOGINS[who].username, password: LOGINS[who].password })
  });
  const data = await res.json();
  if (!data.token) throw new Error(`${who} login failed: ${data.message || res.status}`);
  const context = await browser.createBrowserContext();
  context.token = data.token;
  return context;
}

const only = process.argv.slice(2);
const shots = only.length ? SHOTS.filter(s => only.includes(s.name)) : SHOTS;
for (const s of shots) {
  if (s.login && !LOGINS[s.login].password) {
    console.error(`Set ${s.login === 'guest' ? 'HELP_GUEST_PASSWORD' : 'HELP_VENUE_SECRET'} for the ${s.login} login (the demo venue's passwords).`);
    process.exit(1);
  }
}
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--hide-scrollbars']
});
const contexts = {};
let failed = 0;
try {
  for (const s of shots) {
    try {
      const context = s.login ? (contexts[s.login] ||= await logIn(browser, s.login)) : (contexts.none ||= await browser.createBrowserContext());
      const page = await context.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      // Signed in, with the staff header folded away (the header's own saved
      // preference) so the shot shows the page itself.
      if (context.token) {
        await page.evaluateOnNewDocument((t, fold) => {
          localStorage.setItem('authToken', t);
          localStorage.setItem('header_collapsed', String(fold));
        }, context.token, !s.keepHeader);
      }
      await page.goto(`${SITE}${s.url}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await settle(page);
      if (s.before) await s.before(page);
      await pause(s.wait || 800);
      const file = path.join(OUT, `${s.name}.webp`);
      const options = { path: file, type: 'webp', quality: 82 };
      if (s.element) await (await s.element(page)).asElement().screenshot(options);
      else await page.screenshot({ ...options, captureBeyondViewport: false });
      await page.close();
      console.log(`  ${s.name}.webp`);
    } catch (error) {
      failed++;
      console.error(`  ${s.name}: ${error.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
}
console.log(`${shots.length - failed} of ${shots.length} screenshots saved in ${path.relative(process.cwd(), OUT)}`);
process.exit(failed ? 1 : 0);
