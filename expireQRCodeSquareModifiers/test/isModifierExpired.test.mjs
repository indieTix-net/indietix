import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModifierExpired } from '../src/index.mjs';

// isModifierExpired compares against "now" internally (with a 5-hour
// grace buffer), so these use dates clearly in the past/future relative
// to whenever the test actually runs, rather than fixed calendar dates.

function formatModifierName(date, { withTime = true } = {}) {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  if (!withTime) return `Fri ${mm}-${dd}-${yyyy} (Main Theatre)`;
  return `Fri ${mm}-${dd}-${yyyy} 3:15 PM (Main Theatre)`;
}

test('isModifierExpired: a showtime 30 days in the past is expired', () => {
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(isModifierExpired(formatModifierName(past)), true);
});

test('isModifierExpired: a showtime 30 days in the future is not expired', () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  assert.equal(isModifierExpired(formatModifierName(future)), false);
});

test('isModifierExpired: a showtime 2 days in the past is expired (well beyond the 5-hour grace buffer)', () => {
  // formatModifierName hardcodes a 3:15 PM time string regardless of the
  // input Date's actual hour (it only varies the calendar date) -- fine
  // for a multi-day offset, but not precise enough to safely test the
  // exact 5-hour boundary without also reconstructing a correct
  // Chicago-local hour string, which isn't worth the complexity here.
  const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  assert.equal(isModifierExpired(formatModifierName(past)), true);
});

test('isModifierExpired: an unparseable modifier name is treated as not expired (fails safe -- never wrongly deletes)', () => {
  assert.equal(isModifierExpired('Adult'), false);
  assert.equal(isModifierExpired(''), false);
});

test('isModifierExpired: a date-only (no time) showtime 30 days in the past is expired', () => {
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(isModifierExpired(formatModifierName(past, { withTime: false })), true);
});
