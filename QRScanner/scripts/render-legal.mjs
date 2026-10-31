// Regenerates src/public/terms.html and privacy.html from src/legal/*.html
// with the placeholder defaults (what a venue sees before filling in its
// LEGAL_* Client Settings). Run after editing a template: npm run render-legal
import { writeFileSync } from 'fs';
import { LEGAL_PAGES, renderLegalPage } from '../src/utils/legal.mjs';

for (const page of LEGAL_PAGES) {
  const out = new URL(`../src/public/${page}.html`, import.meta.url);
  writeFileSync(out, renderLegalPage(page));
  console.log(`wrote src/public/${page}.html`);
}
