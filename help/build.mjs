// Builds the public help pages from the guide in support/knowledge (the same
// files the support inbox drafts replies from), so there's one source.
//   node build.mjs [--out <dir>]     (default: QRScanner/src/public/help, gitignored)
// Every guide page becomes <name>.html with a sidebar, search and next/previous
// links; index.html lists them all. Links between guide pages, their #sections
// and images are checked: a broken one stops the build.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Marked } from 'marked';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GUIDE_DIR = path.join(here, '..', 'support', 'knowledge');
export const DEFAULT_OUT = path.join(here, '..', 'QRScanner', 'src', 'public', 'help');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// GitHub's heading anchors, so the same links work on GitHub and here.
export const slug = (text) => plain(text).toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

/** Reads the guide: [{ file, name, title, summary, markdown }] in file-name order. */
export function readGuide(dir = GUIDE_DIR) {
  return fs.readdirSync(dir)
    .filter(f => /^\d\d-[a-z0-9-]+\.md$/.test(f))
    .sort()
    .map(file => {
      const markdown = fs.readFileSync(path.join(dir, file), 'utf8');
      const title = (markdown.match(/^# (.+)$/m) || [])[1];
      if (!title) throw new Error(`${file} needs a "# Title" line`);
      // The paragraph right after the title is the page's summary on the help index.
      const summary = (markdown.split('\n').slice(1).find(l => l.trim()) || '').trim();
      if (!summary || /^([#!|>]|[-*+]\s|\d+\.)/.test(summary)) throw new Error(`${file} needs a one-line intro paragraph after its title`);
      return { file, name: file.replace(/\.md$/, ''), title, summary: summary.replace(/\*\*|`/g, ''), markdown };
    });
}

function renderPage(page, guideDir, problems) {
  const headings = [];
  const links = [];
  const images = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const id = slug(html);
        if (depth === 2) headings.push({ id, text: plain(html) });
        if (depth === 1) return `<h1>${html}</h1>\n`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const guide = href.match(/^(\d\d-[a-z0-9-]+)\.md(#[\w-]+)?$/);
        if (guide) {
          links.push({ page: guide[1], anchor: guide[2] ? guide[2].slice(1) : null });
          href = `${guide[1]}.html${guide[2] || ''}`;
        } else if (href.startsWith('#')) {
          links.push({ page: page.name, anchor: href.slice(1) });
        }
        const external = /^https?:/.test(href);
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${text}</a>`;
      },
      image({ href, text }) {
        images.push(href);
        return `<figure><a href="${escapeHtml(href)}"><img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy"></a><figcaption>${escapeHtml(text)}</figcaption></figure>`;
      }
    }
  });
  // An image on its own line shouldn't sit inside a <p>.
  const body = marked.parse(page.markdown).replace(/<p>(<figure>.*?<\/figure>)<\/p>/gs, '$1');
  for (const src of images) {
    if (!/^images\/[\w.-]+\.(png|jpe?g|webp)$/.test(src)) problems.push(`${page.file}: image "${src}" must be images/<file>`);
    else if (!fs.existsSync(path.join(guideDir, src))) problems.push(`${page.file}: missing image ${src} (run npm run screenshots)`);
  }
  return { body, headings, links, images };
}

function layout({ title, pages, current, body, headings, prev, next }) {
  const nav = pages.map(p => {
    const here = current && p.name === current.name;
    const sub = here && headings.length
      ? `<ul class="sections">${headings.map(h => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('')}</ul>` : '';
    return `<li${here ? ' class="current"' : ''}><a href="${p.name}.html"${here ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a>${sub}</li>`;
  }).join('\n          ');
  const pager = current ? `
      <nav class="pager" aria-label="Next and previous pages">
        ${prev ? `<a class="prev" href="${prev.name}.html"><span>Previous</span>${escapeHtml(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a class="next" href="${next.name}.html"><span>Next</span>${escapeHtml(next.title)}</a>` : '<span></span>'}
      </nav>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} · IndieTix Help</title>
  <link rel="stylesheet" href="help.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="index.html">IndieTix <span>Help</span></a>
    <form class="search" role="search" action="index.html">
      <input type="search" name="q" id="help-search" placeholder="Search the guide" aria-label="Search the guide" autocomplete="off">
      <div class="results" id="help-results" hidden></div>
    </form>
    <a class="login" href="../login.html">Log in</a>
  </header>
  <div class="layout">
    <nav class="sidebar" aria-label="Guide pages">
      <details open>
        <summary>All topics</summary>
        <ul>
          ${nav}
        </ul>
      </details>
    </nav>
    <main>
      ${body}
      ${pager}
      <footer>Questions this guide doesn't answer? Email <a href="mailto:support@indietix.net">support@indietix.net</a> with your Client ID. This guide is also on <a href="https://github.com/indieTix-net/indietix/tree/main/support/knowledge" rel="noopener">GitHub</a>.</footer>
    </main>
  </div>
  <script src="search-index.js"></script>
  <script src="help.js"></script>
</body>
</html>
`;
}

/** Builds the help pages from guideDir into outDir. Returns the list of pages written; throws on a broken link or image. */
export function build(outDir = DEFAULT_OUT, guideDir = GUIDE_DIR) {
  const pages = readGuide(guideDir);
  const problems = [];
  const rendered = pages.map(p => ({ page: p, ...renderPage(p, guideDir, problems) }));
  const anchors = new Map(rendered.map(r => [r.page.name, new Set(
    [...r.page.markdown.matchAll(/^#{2,6} (.+)$/gm)].map(m => slug(new Marked().parseInline(m[1])))
  )]));
  for (const r of rendered) {
    for (const l of r.links) {
      if (!anchors.has(l.page)) problems.push(`${r.page.file}: link to missing page ${l.page}.md`);
      else if (l.anchor && !anchors.get(l.page).has(l.anchor)) problems.push(`${r.page.file}: link to missing section ${l.page}.md#${l.anchor}`);
    }
  }
  if (problems.length) throw new Error(`Help build stopped:\n  ${problems.join('\n  ')}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
  for (const asset of ['help.css', 'help.js']) fs.copyFileSync(path.join(here, 'assets', asset), path.join(outDir, asset));
  for (const img of new Set(rendered.flatMap(r => r.images))) fs.copyFileSync(path.join(guideDir, img), path.join(outDir, img));

  const written = [];
  rendered.forEach((r, i) => {
    const html = layout({ title: r.page.title, pages, current: r.page, body: r.body, headings: r.headings, prev: pages[i - 1], next: pages[i + 1] });
    fs.writeFileSync(path.join(outDir, `${r.page.name}.html`), html);
    written.push(`${r.page.name}.html`);
  });
  const cards = pages.map(p => `<li><a href="${p.name}.html"><strong>${escapeHtml(p.title)}</strong><span>${escapeHtml(p.summary)}</span></a></li>`).join('\n        ');
  const index = `<h1>IndieTix Help</h1>
      <p class="lede">How to run your box office with IndieTix: adding shows, selling, checking people in, refunds, reports and more. Search above, or pick a topic.</p>
      <ul class="cards">
        ${cards}
      </ul>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), layout({ title: 'IndieTix Help', pages, current: null, body: index, headings: [] }));
  written.push('index.html');

  // Search: every page and section, with its text.
  const entries = [];
  for (const r of rendered) {
    const sections = r.page.markdown.split(/^## /m);
    entries.push({ t: r.page.title, u: `${r.page.name}.html`, x: plain(new Marked().parse(sections[0].replace(/^# .+$/m, ''))).replace(/\s+/g, ' ').trim() });
    for (const s of sections.slice(1)) {
      const heading = s.split('\n')[0];
      entries.push({ t: `${r.page.title}: ${plain(heading)}`, h: plain(heading), u: `${r.page.name}.html#${slug(new Marked().parseInline(heading))}`, x: plain(new Marked().parse(s.slice(heading.length))).replace(/\s+/g, ' ').trim() });
    }
  }
  fs.writeFileSync(path.join(outDir, 'search-index.js'), `window.HELP_INDEX = ${JSON.stringify(entries)};\n`);
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > -1 ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT;
  try {
    const written = build(out);
    console.log(`Built ${written.length} help pages in ${path.relative(process.cwd(), out) || out}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
