import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlannedPostSlots, chicagoWallClockToDate, formatChicagoWallClock, getChicagoDateParts } from '../src/index.mjs';

// Slots are counted on Chicago's calendar and clock, so expectations are
// exact Chicago wall-clock times whatever timezone the tests run in.
const chicago = (date) => formatChicagoWallClock(date);
function expectedSlot(anchorDate, daysFromAnchor, time) {
  const p = getChicagoDateParts(anchorDate);
  const base = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + daysFromAnchor));
  const [hours, minutes] = time.split(':').map(Number);
  return chicagoWallClockToDate(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hours, minutes);
}

const anchorDate = new Date('2026-05-01T00:00:00.000Z');
const lastShowtimeDate = new Date('2026-05-10T23:59:00.000Z');

test('computePlannedPostSlots: converts a day-offset into the correct concrete date', () => {
  const slots = computePlannedPostSlots({ offsets: [{ daysFromAnchor: -2, time: '11:30' }] }, anchorDate, lastShowtimeDate);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].getTime(), expectedSlot(anchorDate, -2, '11:30').getTime());
});

test('computePlannedPostSlots: a slot scheduled after the last showtime is dropped', () => {
  const slots = computePlannedPostSlots(
    { offsets: [{ daysFromAnchor: 0, time: '09:00' }, { daysFromAnchor: 20, time: '09:00' }] },
    anchorDate, lastShowtimeDate
  );
  assert.equal(slots.length, 1, 'the +20-day slot is well past lastShowtimeDate and must be dropped');
  assert.equal(slots[0].getTime(), expectedSlot(anchorDate, 0, '09:00').getTime());
});

test('computePlannedPostSlots: returns an empty array when offsets is missing or not an array', () => {
  assert.deepEqual(computePlannedPostSlots({}, anchorDate, lastShowtimeDate), []);
  assert.deepEqual(computePlannedPostSlots(null, anchorDate, lastShowtimeDate), []);
  assert.deepEqual(computePlannedPostSlots({ offsets: 'not-an-array' }, anchorDate, lastShowtimeDate), []);
});

test('computePlannedPostSlots: skips individual malformed offset entries without dropping the valid ones', () => {
  const slots = computePlannedPostSlots({
    offsets: [
      { daysFromAnchor: -1, time: '10:00' },
      { daysFromAnchor: 'not-a-number', time: '10:00' },
      { daysFromAnchor: -2 }, // missing time
      { daysFromAnchor: 0, time: '14:00' }
    ]
  }, anchorDate, lastShowtimeDate);
  assert.equal(slots.length, 2);
});

test('computePlannedPostSlots: preserves input order (no implicit sort)', () => {
  const slots = computePlannedPostSlots({
    offsets: [{ daysFromAnchor: 3, time: '09:00' }, { daysFromAnchor: -3, time: '09:00' }]
  }, anchorDate, lastShowtimeDate);
  assert.ok(slots[0] > slots[1], 'day +3 listed first in input should still come first in output');
});

test('computePlannedPostSlots: an evening show counts days on Chicago\'s calendar, at Chicago time', () => {
  // Sun 11-29-2026 7:00 PM Chicago is 01:00 UTC on the 30th. +1 day at 11:30
  // must be Mon Nov 30, 11:30 AM Chicago, not Dec 1 / 11:30 UTC.
  const show = new Date('2026-11-30T01:00:00.000Z');
  const last = new Date('2026-12-28T01:00:00.000Z');
  const slots = computePlannedPostSlots({ offsets: [{ daysFromAnchor: 1, time: '11:30' }, { daysFromAnchor: -7, time: '09:00' }] }, show, last);
  assert.deepEqual(slots.map(chicago), ['2026-11-30 11:30:00', '2026-11-22 09:00:00']);
  assert.equal(slots[0].toISOString(), '2026-11-30T17:30:00.000Z');
});

test('chicagoWallClockToDate: handles both sides of the DST change', () => {
  assert.equal(chicagoWallClockToDate(2026, 7, 1, 11, 0).toISOString(), '2026-07-01T16:00:00.000Z'); // CDT
  assert.equal(chicagoWallClockToDate(2026, 12, 1, 11, 0).toISOString(), '2026-12-01T17:00:00.000Z'); // CST
});
