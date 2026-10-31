import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateFromModifierName } from '../src/index.mjs';

test('parseDateFromModifierName: parses a date+time modifier name, interpreted as Chicago (CST, GMT-0600)', () => {
  const date = parseDateFromModifierName('Fri 05-30-2025 3:15 PM (Big Theatre)');
  assert.ok(date instanceof Date);
  // 3:15 PM CST (GMT-0600) == 21:15 UTC.
  assert.equal(date.toISOString(), '2025-05-30T21:15:00.000Z');
});

test('parseDateFromModifierName: parses a date-only modifier name, defaulting to 11:59 PM', () => {
  const date = parseDateFromModifierName('Fri 09-08-2025 (Big Theatre)');
  assert.ok(date instanceof Date);
  // 11:59 PM CST == 05:59 UTC the next day.
  assert.equal(date.toISOString(), '2025-09-09T05:59:00.000Z');
});

test('parseDateFromModifierName: handles a 12-hour-clock edge case (12:00 PM noon)', () => {
  const date = parseDateFromModifierName('Mon 01-01-2026 12:00 PM (Little Theatre)');
  assert.equal(date.toISOString(), '2026-01-01T18:00:00.000Z');
});

test('parseDateFromModifierName: handles single-digit hour without a leading zero', () => {
  const date = parseDateFromModifierName('Sun 05-17-2026 2:30 PM (Main)');
  assert.equal(date.toISOString(), '2026-05-17T20:30:00.000Z');
});

test('parseDateFromModifierName: returns null for text with no recognizable date, rather than throwing', () => {
  assert.equal(parseDateFromModifierName('Adult'), null);
  assert.equal(parseDateFromModifierName(''), null);
  assert.equal(parseDateFromModifierName('Sold Out'), null);
});

test('parseDateFromModifierName: prefers the date+time pattern over the date-only pattern when both could match', () => {
  const date = parseDateFromModifierName('Sat 06-15-2026 7:30 PM (Big Theatre)');
  // If this fell through to the date-only branch it would land at 11:59 PM
  // instead of 7:30 PM -- confirms the time-aware regex takes priority.
  assert.equal(date.toISOString(), '2026-06-16T01:30:00.000Z');
});
