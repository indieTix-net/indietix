import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getChicagoDateParts, formatChicagoTime12h, escapeSvgText, buildDigestSvg } from '../src/index.mjs';

test('getChicagoDateParts: converts a UTC instant to Chicago wall-clock parts (CDT, summer)', () => {
  const parts = getChicagoDateParts(new Date('2026-05-17T20:30:00.000Z'));
  assert.equal(parts.year, '2026');
  assert.equal(parts.month, '05');
  assert.equal(parts.day, '17');
  assert.equal(parts.hour, '15'); // 3:30 PM CDT
  assert.equal(parts.minute, '30');
});

test('getChicagoDateParts: handles the midnight "24" quirk from Intl, normalizing to "00"', () => {
  // Midnight Chicago time -- pick a UTC instant that lands exactly on
  // Chicago midnight during standard time (CST, UTC-6): 06:00 UTC.
  const parts = getChicagoDateParts(new Date('2026-01-15T06:00:00.000Z'));
  assert.equal(parts.hour, '00');
});

test('getChicagoDateParts: withWeekday=true includes a weekday name', () => {
  const parts = getChicagoDateParts(new Date('2026-05-17T20:30:00.000Z'), true);
  assert.ok(parts.weekday, 'expected a weekday field');
  assert.equal(typeof parts.weekday, 'string');
});

test('formatChicagoTime12h: formats as a 12-hour clock time', () => {
  assert.equal(formatChicagoTime12h(new Date('2026-05-17T20:30:00.000Z')), '3:30 PM');
});

test('escapeSvgText: escapes the three characters that would break embedding in an SVG <text> element', () => {
  assert.equal(escapeSvgText('Tom & Jerry <3 > 2'), 'Tom &amp; Jerry &lt;3 &gt; 2');
});

test('escapeSvgText: null/empty input never throws', () => {
  assert.equal(escapeSvgText(null), '');
  assert.equal(escapeSvgText(undefined), '');
  assert.equal(escapeSvgText(''), '');
});

test('buildDigestSvg: produces well-formed SVG containing the escaped day labels and event lines', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dayEntries: [
      { label: 'Mon 5/18', eventEntries: [{ title: 'Movie One', times: '5:30 PM, 7:30 PM' }] },
      { label: 'Tue 5/19', eventEntries: [{ title: 'Movie Two <Director\'s Cut>', times: '8:00 PM' }] }
    ]
  });
  assert.match(svg, /^<svg width="1080" height="1080"/);
  assert.match(svg, /Mon 5\/18/);
  assert.match(svg, /Movie One/);
  assert.match(svg, /5:30 PM, 7:30 PM/);
  assert.match(svg, /Movie Two &lt;Director&#39;s Cut&gt;|Movie Two &lt;Director's Cut&gt;/);
  assert.doesNotMatch(svg, /<Director/, 'raw angle brackets from the title must be escaped, not left as literal SVG markup');
});

// 2026-10-26: title is now bold, showtimes italic and not bold -- each
// rendered as its own <tspan> within the event line's <text> element.
test('buildDigestSvg: title is bold, showtimes are italic and not bold, as separate tspans', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie One', times: '5:30 PM' }] }]
  });
  assert.match(svg, /<tspan font-size="[\d.]+" font-weight="700">Movie One<\/tspan>/, 'title should be in a bold tspan');
  assert.match(svg, /<tspan font-size="[\d.]+" font-weight="400" font-style="italic">5:30 PM<\/tspan>/, 'showtimes should be in an italic, non-bold tspan');
});

test('buildDigestSvg: the "Nothing scheduled" placeholder has no bold/italic split (it is not a real title/times pair)', () => {
  const svg = buildDigestSvg({
    bounds: {}, width: 1080, height: 1080,
    dayEntries: [{ label: 'This week', eventEntries: [{ title: '', times: 'Nothing scheduled' }] }]
  });
  assert.match(svg, /Nothing scheduled/);
  assert.doesNotMatch(svg, /<tspan/, 'the placeholder line should be plain text, not split into title/times tspans');
});

// 2026-10-26: background images are no longer force-cropped to a square --
// the overlay's SVG canvas now matches whatever width/height the actual
// (possibly non-square) background turned out to be.
test('buildDigestSvg: a non-square width/height produces a matching non-square SVG, not a forced square', () => {
  const svg = buildDigestSvg({
    bounds: { top: 20, right: 20, bottom: 20, left: 20 },
    width: 1024,
    height: 576,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie One', times: '7:00 PM' }] }]
  });
  assert.match(svg, /^<svg width="1024" height="576"/);
});

test('buildDigestSvg: a day with no events still gets a "Nothing scheduled" placeholder line, not a blank/broken row', () => {
  const svg = buildDigestSvg({ bounds: {}, width: 1080, height: 1080, dayEntries: [{ label: 'This week', eventEntries: [] }] });
  assert.match(svg, /Nothing scheduled/);
});

test('buildDigestSvg: does not throw on a very long single line (truncates instead of overflowing)', () => {
  const svg = buildDigestSvg({
    bounds: { top: 100, right: 100, bottom: 100, left: 100 },
    width: 1080,
    height: 1080,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'X'.repeat(500), times: '7:00 PM' }] }]
  });
  assert.match(svg, /…/, 'an extremely long line should be truncated with an ellipsis');
});

test('buildDigestSvg: handles many days/events without throwing (shrinks font rather than overflowing)', () => {
  const dayEntries = Array.from({ length: 7 }, (_, i) => ({
    label: `Day ${i}`,
    eventEntries: Array.from({ length: 5 }, (_, j) => ({ title: `Movie ${j}`, times: '5:00 PM' }))
  }));
  const svg = buildDigestSvg({ bounds: { top: 50, right: 50, bottom: 50, left: 50 }, width: 1080, height: 1080, dayEntries });
  assert.match(svg, /<svg/);
});

// 2026-10-26: the two-column block is now centered horizontally within
// the bounds, not left-anchored and stretched to fill the full width --
// a short single-line week should not start right at the left edge.
test('buildDigestSvg: a single short line is centered horizontally, not left-anchored at the bounds edge', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  const xMatch = svg.match(/<text x="([\d.]+)" y="[\d.]+" font-size="[\d.]+" font-weight="700" dominant-baseline="middle"/);
  assert.ok(xMatch, 'expected to find the day-label <text> element');
  const dayLabelX = Number(xMatch[1]);
  assert.ok(dayLabelX > 50, `a short line should be centered well past the left bound (x=50), got x=${dayLabelX}`);
});

test('buildDigestSvg: a line that fills the whole available width is not pushed off past the left bound', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'X'.repeat(500), times: '7:00 PM' }] }]
  });
  const xMatch = svg.match(/<text x="([\d.]+)" y="[\d.]+" font-size="[\d.]+" font-weight="700" dominant-baseline="middle"/);
  assert.ok(xMatch);
  const dayLabelX = Number(xMatch[1]);
  assert.ok(dayLabelX >= 50 && dayLabelX < 100, `a line needing the full width should sit close to the left bound, got x=${dayLabelX}`);
});

// 2026-10-26: date/event/time each get independent size + bold controls.
test('buildDigestSvg: date, event, and time each use their own configured font size and weight', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dateStyle: { fontSize: 30, bold: true },
    eventStyle: { fontSize: 20, bold: false },
    timeStyle: { fontSize: 10, bold: true },
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  assert.match(svg, /font-size="30" font-weight="700" dominant-baseline="middle"[^>]*>Mon</, 'date should use its own size/weight');
  assert.match(svg, /<tspan font-size="20" font-weight="400">Movie<\/tspan>/, 'event should use its own size/weight');
  assert.match(svg, /<tspan font-size="10" font-weight="700" font-style="italic">7:00 PM<\/tspan>/, 'time should use its own size/weight, still italic');
});

test('buildDigestSvg: time bold defaults to false, date/event bold default to true, when not specified', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  assert.match(svg, /font-weight="700" dominant-baseline="middle"[^>]*>Mon</, 'date defaults to bold');
  assert.match(svg, /<tspan font-size="[\d.]+" font-weight="700">Movie<\/tspan>/, 'event defaults to bold');
  assert.match(svg, /<tspan font-size="[\d.]+" font-weight="400" font-style="italic">7:00 PM<\/tspan>/, 'time defaults to not bold');
});

// 2026-10-26: optional header/footer text drawn above/below the grid.
test('buildDigestSvg: header and footer text render when provided, with their own styling', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    headerText: 'Welcome to Liberty Hall',
    headerStyle: { fontSize: 24, bold: true },
    footerText: 'See you there!',
    footerStyle: { fontSize: 12, bold: false },
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  assert.match(svg, /font-size="24" font-weight="700"[^>]*>Welcome to Liberty Hall</);
  assert.match(svg, /font-size="12" font-weight="400"[^>]*>See you there!</);
  // Header should come before the day grid in document order, footer after.
  const headerIdx = svg.indexOf('Welcome to Liberty Hall');
  const gridIdx = svg.indexOf('Mon');
  const footerIdx = svg.indexOf('See you there!');
  assert.ok(headerIdx < gridIdx && gridIdx < footerIdx, 'expected header, then grid, then footer in document order');
});

test('buildDigestSvg: no header/footer text at all when not provided', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 1080,
    height: 1080,
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  // Only the day label + event text elements should exist -- no extra
  // <text> for a header/footer that was never given.
  const textCount = (svg.match(/<text /g) || []).length;
  assert.equal(textCount, 2, 'expected exactly the day-label and event-line <text> elements, nothing extra');
});

// 2026-10-26: header/footer text that's too long to fit on one line wraps
// onto additional lines instead of truncating with an ellipsis.
test('buildDigestSvg: header text too long for one line wraps onto multiple lines instead of truncating', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 400,
    height: 1080,
    headerText: 'This is a genuinely long header sentence that cannot possibly fit on just one line at this width',
    headerStyle: { fontSize: 24, bold: true },
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  const headerTextElements = svg.match(/<text x="[\d.]+" y="[\d.]+" text-anchor="middle" font-size="24" font-weight="700"[^>]*>[^<]*<\/text>/g) || [];
  assert.ok(headerTextElements.length > 1, `expected the header to wrap onto multiple <text> lines, got ${headerTextElements.length}`);
  assert.doesNotMatch(svg, /…/, 'header text should never be truncated with an ellipsis');
  // Every word from the original text should still be present somewhere
  // in the wrapped output -- nothing should be dropped.
  const combined = headerTextElements.join(' ');
  for (const word of ['This', 'genuinely', 'long', 'sentence', 'width']) {
    assert.match(combined, new RegExp(word), `expected "${word}" to survive wrapping, not be dropped`);
  }
});

// 2026-10-26: centered via SVG's own text-anchor="middle" at one fixed x
// (the real glyph widths the renderer knows, not this file's average-
// char-width estimate) -- every wrapped line should share that same x
// regardless of how long each individual line is.
test('buildDigestSvg: every wrapped header line shares the same centered x (text-anchor="middle"), not a per-line estimate', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 400,
    height: 1080,
    headerText: 'This is a genuinely long header sentence that cannot possibly fit on just one line at this width',
    headerStyle: { fontSize: 24, bold: true },
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  const xs = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="middle" font-size="24" font-weight="700"/g)].map(m => m[1]);
  assert.ok(xs.length > 1, 'expected multiple wrapped lines');
  assert.ok(xs.every(x => x === xs[0]), `expected every line to share the same centered x, got: ${xs.join(', ')}`);
  // bounds left=50, width=400, right=50 -> areaWidth=300, center = 50+150=200
  assert.equal(xs[0], '200');
});

test('buildDigestSvg: footer text that wraps grows upward from the bottom bound, not off the canvas', () => {
  const svg = buildDigestSvg({
    bounds: { top: 50, right: 50, bottom: 50, left: 50 },
    width: 400,
    height: 1080,
    footerText: 'Another genuinely long footer sentence that cannot fit on one line at this width either',
    footerStyle: { fontSize: 24, bold: false },
    dayEntries: [{ label: 'Mon', eventEntries: [{ title: 'Movie', times: '7:00 PM' }] }]
  });
  const footerYs = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle" font-size="24" font-weight="400"[^>]*>/g)].map(m => Number(m[1]));
  assert.ok(footerYs.length > 1, 'expected the footer to wrap onto multiple lines');
  // All footer lines should sit above the bottom bound (1080 - 50 = 1030).
  for (const y of footerYs) {
    assert.ok(y < 1030, `expected every footer line to stay within the bottom bound, got y=${y}`);
  }
});
