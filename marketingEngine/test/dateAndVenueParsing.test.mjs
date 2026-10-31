import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateFromModifierName, parseVenueAndDescriptors, addDaysToYMD } from '../src/index.mjs';

// parseDateFromModifierName is a verbatim copy of
// expireQRCodeSquareModifiers' function of the same name -- same core
// cases re-verified here since it's a separate copy that could drift.

test('parseDateFromModifierName: parses a date+time modifier name (Chicago/CST, GMT-0600)', () => {
  const date = parseDateFromModifierName('Fri 05-30-2025 3:15 PM (Big Theatre)');
  assert.equal(date.toISOString(), '2025-05-30T21:15:00.000Z');
});

test('parseDateFromModifierName: parses a date-only modifier name, defaulting to 11:59 PM', () => {
  const date = parseDateFromModifierName('Fri 09-08-2025 (Big Theatre)');
  assert.equal(date.toISOString(), '2025-09-09T05:59:00.000Z');
});

test('parseDateFromModifierName: returns null for unparseable text rather than throwing', () => {
  assert.equal(parseDateFromModifierName('Adult'), null);
  assert.equal(parseDateFromModifierName(''), null);
});

test('parseVenueAndDescriptors: extracts venue and additional descriptors from the parenthetical', () => {
  const result = parseVenueAndDescriptors('Sun 05-25-2025 8:00 PM (Little Theatre, Closed Caption)');
  assert.equal(result.venue, 'Little Theatre');
  assert.deepEqual(result.descriptors, ['Closed Caption']);
});

test('parseVenueAndDescriptors: a single-value parenthetical is venue-only, no descriptors', () => {
  const result = parseVenueAndDescriptors('Fri 05-30-2025 3:15 PM (Big Theatre)');
  assert.equal(result.venue, 'Big Theatre');
  assert.deepEqual(result.descriptors, []);
});

test('parseVenueAndDescriptors: multiple descriptors after the venue are all captured', () => {
  const result = parseVenueAndDescriptors('Sat 06-01-2025 7:00 PM (Main, 3D, Closed Caption)');
  assert.deepEqual(result.descriptors, ['3D', 'Closed Caption']);
});

test('parseVenueAndDescriptors: no parenthetical at all returns null venue and empty descriptors', () => {
  const result = parseVenueAndDescriptors('Sat 06-01-2025 7:00 PM');
  assert.equal(result.venue, null);
  assert.deepEqual(result.descriptors, []);
});

test('addDaysToYMD: simple same-month addition', () => {
  assert.deepEqual(addDaysToYMD(2026, 5, 10, 3), { year: 2026, month: 5, day: 13 });
});

test('addDaysToYMD: crosses a month boundary', () => {
  assert.deepEqual(addDaysToYMD(2026, 1, 30, 3), { year: 2026, month: 2, day: 2 });
});

test('addDaysToYMD: crosses a year boundary', () => {
  assert.deepEqual(addDaysToYMD(2026, 12, 30, 3), { year: 2027, month: 1, day: 2 });
});

test('addDaysToYMD: handles a leap-day crossing correctly (2028 is a leap year)', () => {
  assert.deepEqual(addDaysToYMD(2028, 2, 28, 1), { year: 2028, month: 2, day: 29 });
  assert.deepEqual(addDaysToYMD(2028, 2, 29, 1), { year: 2028, month: 3, day: 1 });
});

test('addDaysToYMD: negative deltas go backwards correctly across a month boundary', () => {
  assert.deepEqual(addDaysToYMD(2026, 3, 1, -1), { year: 2026, month: 2, day: 28 });
});
