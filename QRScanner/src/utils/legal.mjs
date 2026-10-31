// Terms of Service and Privacy Policy, rendered from one generic template
// per page (src/legal/*.html) with each venue's own details from its
// Client.configuration LEGAL_* keys. Rendered to finished HTML on the
// server, never filled in by browser JS: carriers reviewing a 10DLC
// campaign read the registered privacy/terms URLs without running scripts.
//
// Two consumers:
//   - GET /legal/:page?client=<id> in app.mjs (that venue's pages)
//   - deploy.sh static-push-legal, which fetches that route for the
//     environment's main venue and uploads the result as the plain
//     privacy.html / terms.html (the URLs a campaign registers)
// The committed src/public/terms.html and privacy.html are this renderer's
// output with LEGAL_DEFAULTS (npm run render-legal; a test checks they match).
import { readFileSync } from 'fs';

export const LEGAL_PAGES = ['terms', 'privacy'];

// Operator-editable via Client Settings (USER_DEFINABLE in
// clientSetup-Teardown, CLIENT_SETTINGS_KEYS in app.mjs).
export const LEGAL_KEYS = [
  'LEGAL_NAME',          // formal name, e.g. "Example Cinema Inc."
  'LEGAL_SHORT_NAME',    // how the pages refer to the venue, e.g. "Example Cinema"
  'LEGAL_ADDRESS',       // street, city, state, zip
  'LEGAL_PHONE',
  'LEGAL_EMAIL',
  'LEGAL_STATE',         // governing law, e.g. "Kansas"
  'LEGAL_COURT_COUNTY'   // where disputes are heard, e.g. "Douglas County, Kansas"
];

export const LEGAL_DEFAULTS = {
  LEGAL_NAME: 'Your Venue Inc.',
  LEGAL_SHORT_NAME: 'Your Venue',
  LEGAL_ADDRESS: '111 Your Address, Your City, ST 00000',
  LEGAL_PHONE: '111-Your-Phone',
  LEGAL_EMAIL: 'privacy@indietix.net',
  LEGAL_STATE: 'Your State',
  LEGAL_COURT_COUNTY: 'Your County, Your State'
};

const TEMPLATES = Object.fromEntries(LEGAL_PAGES.map(page =>
  [page, readFileSync(new URL(`../legal/${page}.html`, import.meta.url), 'utf8')]));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The venue's values, with defaults for anything blank. A venue that sets
// only LEGAL_NAME is referred to by that name rather than "Your Venue".
export function legalValues(config = {}) {
  const set = key => typeof config[key] === 'string' && config[key].trim() !== '';
  const values = {};
  for (const key of LEGAL_KEYS) values[key] = set(key) ? config[key].trim() : LEGAL_DEFAULTS[key];
  if (!set('LEGAL_SHORT_NAME') && set('LEGAL_NAME')) values.LEGAL_SHORT_NAME = values.LEGAL_NAME;
  return values;
}

// links: { privacyLink, termsLink, assetBase } -- defaults suit the static
// site (relative links, stylesheet next to the page).
export function renderLegalPage(page, config = {}, links = {}) {
  if (!LEGAL_PAGES.includes(page)) throw new Error(`Unknown legal page: ${page}`);
  const values = {
    ...legalValues(config),
    PRIVACY_LINK: links.privacyLink ?? 'privacy.html',
    TERMS_LINK: links.termsLink ?? 'terms.html',
    ASSET_BASE: links.assetBase ?? ''
  };
  return TEMPLATES[page].replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Legal template ${page} has unknown placeholder ${match}`);
    return escapeHtml(values[key]);
  });
}
