import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseShowtimeLabel } from '../src/utils/native-events.mjs';

// ---- the shared showtime form (src/public/showtime-form.js) ----
// Movie Info Lookup, Event Info Entry and the Showtimes page all build their
// showtime text with it. Whatever it writes, the server must read back to the
// same time, room and extras.

const source = readFileSync(new URL('../src/public/showtime-form.js', import.meta.url), 'utf8');
const sandbox = { window: { INDIETIX_API_URL: 'http://api.test' }, document: {}, localStorage: { getItem: () => null }, console };
vm.runInNewContext(source, sandbox);
const form = sandbox.window.ShowtimeForm;

test('movies put extras in the brackets, events after a dash; both read back to the same time, room and extras', () => {
  const movie = form.formatShowtime('2030-06-07', '19:00', 'Little Theater', ['21+', 'Open Caption'], 'movie');
  assert.equal(movie, 'Fri 06-07-2030 7:00 PM (Little Theater, 21+, Open Caption)');
  const event = form.formatShowtime('2030-06-07', '19:00', 'Little Theater', ['21+', 'Open Caption'], 'event');
  assert.equal(event, 'Fri 06-07-2030 7:00 PM (Little Theater) - 21+ - Open Caption');
  for (const label of [movie, event]) {
    const parsed = parseShowtimeLabel(label);
    assert.deepEqual([parsed.startsAt, parsed.venue, parsed.descriptors], ['2030-06-07 19:00:00', 'Little Theater', ['21+', 'Open Caption']], label);
  }
});

test('noon, midnight and no extras', () => {
  assert.equal(form.formatShowtime('2030-06-09', '12:05', 'Main', [], 'event'), 'Sun 06-09-2030 12:05 PM (Main)');
  assert.equal(form.formatShowtime('2030-06-09', '00:30', 'Main', [], 'movie'), 'Sun 06-09-2030 12:30 AM (Main)');
  assert.equal(parseShowtimeLabel('Sun 06-09-2030 12:30 AM (Main)').startsAt, '2030-06-09 00:30:00');
});

test('seat rules match the server\'s', () => {
  assert.deepEqual({ ...form.checkSeats('', '0') }, { capacity: null, heldSeats: 0 });
  assert.deepEqual({ ...form.checkSeats('120', '4') }, { capacity: 120, heldSeats: 4 });
  assert.match(form.checkSeats('ten', '0').error, /whole number/);
  assert.match(form.checkSeats('', '2').error, /capacity to be held from/);
  assert.match(form.checkSeats('3', '4').error, /more than the capacity/);
  assert.equal(form.describeSeats(null, 0), 'no seat limit');
  assert.equal(form.describeSeats(1, 0), '1 seat');
  assert.equal(form.describeSeats(120, 4), '120 seats, 4 held');
});
