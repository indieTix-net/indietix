import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToE164, formatForDisplay, maskForDisplay } from '../src/phone.mjs';

test('normalizeToE164: accepts the documented input formats', () => {
  const expected = '+19135551234';
  assert.equal(normalizeToE164('(913) 555-1234'), expected);
  assert.equal(normalizeToE164('913.555.1234'), expected);
  assert.equal(normalizeToE164('913-555-1234'), expected);
  assert.equal(normalizeToE164('9135551234'), expected);
  assert.equal(normalizeToE164('19135551234'), expected);
  assert.equal(normalizeToE164('+19135551234'), expected);
  assert.equal(normalizeToE164('+1 (913) 555-1234'), expected);
});

test('normalizeToE164: rejects empty/null/non-string input', () => {
  assert.equal(normalizeToE164(''), null);
  assert.equal(normalizeToE164(null), null);
  assert.equal(normalizeToE164(undefined), null);
  assert.equal(normalizeToE164(9135551234), null);
});

test('normalizeToE164: rejects too few or too many digits', () => {
  assert.equal(normalizeToE164('555-1234'), null);
  assert.equal(normalizeToE164('91355512345678'), null);
});

test('normalizeToE164: rejects non-US country codes rather than coercing', () => {
  assert.equal(normalizeToE164('+442071234567'), null);
  assert.equal(normalizeToE164('+525512345678'), null);
});

test('normalizeToE164: rejects area codes starting with 0 or 1 (NANP rule)', () => {
  assert.equal(normalizeToE164('0135551234'), null);
  assert.equal(normalizeToE164('1135551234'), null);
});

test('normalizeToE164: strips noise characters (spaces, dots, parens, mid-string non-digits)', () => {
  assert.equal(normalizeToE164('  913 555 1234  '), '+19135551234');
  assert.equal(normalizeToE164('913-555-1234 ext 0'), null); // extra digits from "ext 0" push it over 10/11
});

test('formatForDisplay: formats a valid US E.164 number', () => {
  assert.equal(formatForDisplay('+19135551234'), '(913) 555-1234');
});

test('formatForDisplay: returns input as-is for non-US-E.164 strings, never throws', () => {
  assert.equal(formatForDisplay(''), '');
  assert.equal(formatForDisplay(null), '');
  assert.equal(formatForDisplay('not a number'), 'not a number');
  assert.equal(formatForDisplay('+442071234567'), '+442071234567');
});

test('maskForDisplay: masks all but the last 4 digits', () => {
  assert.equal(maskForDisplay('+19135551234'), '(xxx) xxx-1234');
});

test('maskForDisplay: returns empty string for invalid input, never throws', () => {
  assert.equal(maskForDisplay(''), '');
  assert.equal(maskForDisplay(null), '');
  assert.equal(maskForDisplay('garbage'), '');
});
