import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlannedPostSlots } from '../src/index.mjs';

// computePlannedPostSlots uses local-timezone Date methods (setDate/
// setHours) internally, so "day N at HH:MM" is relative to whatever
// timezone the Node process itself is running in -- always UTC on real
// Lambda, but not necessarily UTC wherever these tests run. Rather than
// hardcode an absolute calendar date (which would only be correct in
// one specific runner timezone), these tests compute the SAME expected
// value via the identical recipe the function uses, so they verify the
// actual offset/bounding contract correctly regardless of local TZ.
function expectedSlot(anchorDate, daysFromAnchor, time) {
  const [hours, minutes] = time.split(':').map(Number);
  const d = new Date(anchorDate);
  d.setDate(d.getDate() + daysFromAnchor);
  d.setHours(hours, minutes, 0, 0);
  return d;
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
