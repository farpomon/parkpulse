import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimeOfDay,
  nextScheduledRun,
  isWithinWindow,
  describeSchedule,
} from '../src/schedule.mjs';

const monTue3pm = { enabled: true, days: ['mon', 'tue'], hour: 15, minute: 0, windowMinutes: 30 };

// 2026-08-31 is a Monday, so 09-01 Tue, 09-02 Wed, 09-05 Sat, 09-06 Sun.
const at = (iso) => new Date(iso);

test('parses a 24-hour time', () => {
  assert.deepEqual(parseTimeOfDay('15:00'), { hour: 15, minute: 0 });
  assert.deepEqual(parseTimeOfDay('9:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseTimeOfDay(' 23:59 '), { hour: 23, minute: 59 });
});

test('rejects times that are not HH:MM', () => {
  for (const bad of ['3pm', '25:00', '15:60', '15', '', null, 'noon']) {
    assert.equal(parseTimeOfDay(bad), null, String(bad));
  }
});

test('from Monday morning, the next run is Monday 15:00', () => {
  const next = nextScheduledRun(monTue3pm, at('2026-08-31T09:00:00'));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 15);
  assert.equal(next.getDate(), 31);
});

test('from Monday evening, the next run is Tuesday 15:00', () => {
  const next = nextScheduledRun(monTue3pm, at('2026-08-31T18:00:00'));
  assert.equal(next.getDay(), 2);
  assert.equal(next.getDate(), 1);
});

test('from Tuesday evening, it skips to next Monday', () => {
  // The long wait. Wednesday through Sunday are not watched at all.
  const next = nextScheduledRun(monTue3pm, at('2026-09-01T18:00:00'));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 7);
});

test('from midweek, the next run is the following Monday', () => {
  const next = nextScheduledRun(monTue3pm, at('2026-09-03T12:00:00'));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 7);
});

test('exactly at 15:00 the run is not re-scheduled for today', () => {
  // Strictly-after, or the loop would re-enter the same window forever.
  const next = nextScheduledRun(monTue3pm, at('2026-08-31T15:00:00'));
  assert.equal(next.getDate(), 1);
});

test('a schedule with no days never fires', () => {
  assert.equal(nextScheduledRun({ ...monTue3pm, days: [] }), null);
});

test('3pm stays 3pm across the DST change', () => {
  // Vancouver falls back on 2026-11-01. A wake-up computed in UTC offsets
  // would drift an hour; a person who said "3pm" means 3pm either way.
  const before = nextScheduledRun(monTue3pm, at('2026-10-26T09:00:00'));
  const after = nextScheduledRun(monTue3pm, at('2026-11-02T09:00:00'));
  assert.equal(before.getHours(), 15);
  assert.equal(after.getHours(), 15);
});

test('the window covers its length and then closes', () => {
  const start = at('2026-08-31T15:00:00');
  assert.equal(isWithinWindow(start, 30, at('2026-08-31T15:00:00')), true);
  assert.equal(isWithinWindow(start, 30, at('2026-08-31T15:29:59')), true);
  assert.equal(isWithinWindow(start, 30, at('2026-08-31T15:30:00')), false);
  assert.equal(isWithinWindow(start, 30, at('2026-08-31T14:59:00')), false);
});

test('no window start means not in a window', () => {
  assert.equal(isWithinWindow(null, 30), false);
});

test('the schedule describes itself for the log', () => {
  assert.match(describeSchedule(monTue3pm), /Mon and Tue at 15:00/);
  assert.match(describeSchedule({ enabled: false }), /continuously/);
});
