import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { todayInChicago, isValidDateString, buildEborXml, convertToCSV, escapeCSVField } = require('../src/index.js');

test('todayInChicago: returns a YYYY-MM-DD string', () => {
  const result = todayInChicago();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('todayInChicago: matches a direct Intl computation for America/Chicago "now"', () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const expected = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
  assert.equal(todayInChicago(), expected);
});

test('isValidDateString: accepts a real, well-formed date', () => {
  assert.equal(isValidDateString('2026-05-17'), true);
});

test('isValidDateString: rejects wrong formats', () => {
  assert.equal(isValidDateString('05-17-2026'), false);
  assert.equal(isValidDateString('2026/05/17'), false);
  assert.equal(isValidDateString('2026-5-17'), false);
  assert.equal(isValidDateString(''), false);
  assert.equal(isValidDateString(null), false);
  assert.equal(isValidDateString(20260517), false);
});

test('isValidDateString: rejects a calendar-impossible date (e.g. Feb 30) rather than silently rolling it over', () => {
  // new Date('2026-02-30T00:00:00Z') rolls over to March 2 -- the
  // round-trip-and-compare check is specifically there to catch this.
  assert.equal(isValidDateString('2026-02-30'), false);
});

test('isValidDateString: accepts a real leap day', () => {
  assert.equal(isValidDateString('2028-02-29'), true);
});

test('buildEborXml: produces the comScore-compatible format with the date tag and CSV-style rows', () => {
  const xml = buildEborXml(
    [{ Title: 'Digger', 'Film Code': 'LH1234', Gross: 150.5 }],
    '2026-04-26', '69938'
  );
  assert.match(xml, /^<Nightly_box_office>\n<20260426>/);
  assert.match(xml, /69938,LH1234,Digger,150\.50/);
  assert.match(xml, /<\/20260426>\n<\/Nightly_box_office>\n$/);
});

test('buildEborXml: strips commas from titles (would otherwise break the CSV-style row) and escapes & and <', () => {
  const xml = buildEborXml(
    [{ Title: 'Tom & Jerry: The Movie, Pt. 1 <Director\'s Cut>', 'Film Code': 'AB1234', Gross: 10 }],
    '2026-01-01', '69938'
  );
  assert.doesNotMatch(xml, /Movie, Pt\. 1/, 'comma must be stripped to a single space, not escaped');
  assert.match(xml, /Tom &amp; Jerry: The Movie  Pt\. 1 &lt;Director's Cut>/);
});

test('buildEborXml: a missing Gross defaults to 0.00 rather than "NaN"', () => {
  const xml = buildEborXml([{ Title: 'Free Screening', 'Film Code': 'ZZ0000' }], '2026-01-01', '69938');
  assert.match(xml, /ZZ0000,Free Screening,0\.00/);
});

test('buildEborXml: an empty rows array still produces valid wrapper tags with no data rows', () => {
  const xml = buildEborXml([], '2026-01-01', '69938');
  assert.equal(xml, '<Nightly_box_office>\n<20260101>\n</20260101>\n</Nightly_box_office>\n');
});

test('convertToCSV: no header row, CRLF line endings per RFC 4180', () => {
  const csv = convertToCSV({ rows: [{ a: '1', b: '2' }, { a: '3', b: '4' }] });
  assert.equal(csv, '1,2\r\n3,4\r\n');
});

test('convertToCSV: an empty result set produces the literal "No data found" body', () => {
  assert.equal(convertToCSV({ rows: [] }), 'No data found\n');
});

test('convertToCSV: null/undefined cell values become empty fields, not the string "null"', () => {
  const csv = convertToCSV({ rows: [{ a: null, b: undefined, c: 'x' }] });
  assert.equal(csv, ',,x\r\n');
});

test('escapeCSVField: quotes a field containing a comma, newline, or double-quote', () => {
  assert.equal(escapeCSVField('a,b'), '"a,b"');
  assert.equal(escapeCSVField('a\nb'), '"a\nb"');
  assert.equal(escapeCSVField('a"b'), '"a""b"');
});

test('escapeCSVField: a plain field is left unquoted', () => {
  assert.equal(escapeCSVField('plain'), 'plain');
});
