import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDate, explainSkip, parseWeekdays } from '../src/dates.mjs';

const offered = (...isos) => isos.map((iso) => ({ iso, label: iso.slice(8) }));
const window2026 = { earliest: '2026-09-01', latest: '2026-12-31' };

test('takes the earliest date inside the window', () => {
  const chosen = chooseDate(offered('2026-11-04', '2026-09-15', '2026-10-01'), window2026);
  assert.equal(chosen.iso, '2026-09-15');
});

test('refuses dates before the window', () => {
  assert.equal(chooseDate(offered('2026-08-31'), window2026), null);
});

test('refuses dates after the window', () => {
  assert.equal(chooseDate(offered('2027-01-01'), window2026), null);
});

test('window bounds are inclusive on both ends', () => {
  assert.equal(chooseDate(offered('2026-09-01'), window2026).iso, '2026-09-01');
  assert.equal(chooseDate(offered('2026-12-31'), window2026).iso, '2026-12-31');
});

test('books nothing at all when no window is set', () => {
  // The dangerous default. An unbounded booker takes whatever it is offered,
  // so the absence of a window means take nothing, never take anything.
  assert.equal(chooseDate(offered('2026-09-15'), {}), null);
  assert.equal(chooseDate(offered('2026-09-15'), { earliest: '2026-09-01' }), null);
  assert.equal(chooseDate(offered('2026-09-15'), { latest: '2026-12-31' }), null);
});

test('honours a weekday restriction', () => {
  // 2026-09-15 is a Tuesday; 2026-09-16 a Wednesday.
  const guards = { ...window2026, weekdays: ['wed'] };
  assert.equal(chooseDate(offered('2026-09-15', '2026-09-16'), guards).iso, '2026-09-16');
});

test('a weekday restriction can rule out every offered date', () => {
  const guards = { ...window2026, weekdays: ['sun'] };
  assert.equal(chooseDate(offered('2026-09-15', '2026-09-16'), guards), null);
});

test('malformed dates are never selected', () => {
  assert.equal(chooseDate(offered('not-a-date', '2026-13-45'), window2026), null);
});

test('an empty calendar selects nothing', () => {
  assert.equal(chooseDate([], window2026), null);
  assert.equal(chooseDate(null, window2026), null);
});

test('the date read is the date meant, in any timezone', () => {
  // Parsing at local midnight would shift the day backwards west of UTC and
  // book the wrong appointment. Asserted here so that never silently returns.
  const original = process.env.TZ;
  try {
    for (const tz of ['America/Vancouver', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(chooseDate(offered('2026-09-15'), window2026).iso, '2026-09-15', tz);
    }
  } finally {
    process.env.TZ = original;
  }
});

test('a skip explains what was offered and what was wanted', () => {
  const reason = explainSkip(offered('2027-03-02'), window2026);
  assert.match(reason, /2027-03-02/);
  assert.match(reason, /2026-09-01/);
  assert.match(reason, /2026-12-31/);
});

test('an empty calendar explains itself too', () => {
  assert.match(explainSkip([], window2026), /no selectable dates/);
});

test('weekday parsing accepts long and short forms, ignores junk', () => {
  assert.deepEqual(parseWeekdays('Monday, tue, WED'), ['mon', 'tue', 'wed']);
  assert.deepEqual(parseWeekdays('caturday, mon'), ['mon']);
  assert.deepEqual(parseWeekdays(''), []);
  assert.deepEqual(parseWeekdays(undefined), []);
});
