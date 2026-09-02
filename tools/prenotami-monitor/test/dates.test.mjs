import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseDate,
  explainSkip,
  parseWeekdays,
  parseBlackouts,
} from '../src/dates.mjs';

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

// --- Blackouts: dates you cannot attend ---
// A window cannot express "any time except December". These can.

test('a whole month can be blacked out', () => {
  assert.deepEqual(parseBlackouts('2026-12'), [{ from: '2026-12-01', to: '2026-12-31' }]);
});

test('month blackouts get the right last day, February included', () => {
  assert.equal(parseBlackouts('2026-02')[0].to, '2026-02-28');
  assert.equal(parseBlackouts('2028-02')[0].to, '2028-02-29');
  assert.equal(parseBlackouts('2026-04')[0].to, '2026-04-30');
});

test('single days and spans work too', () => {
  assert.deepEqual(parseBlackouts('2026-12-25'), [{ from: '2026-12-25', to: '2026-12-25' }]);
  assert.deepEqual(parseBlackouts('2026-12-01..2026-12-14'), [
    { from: '2026-12-01', to: '2026-12-14' },
  ]);
});

test('a reversed span is read the way it was meant', () => {
  assert.deepEqual(parseBlackouts('2026-12-14..2026-12-01'), [
    { from: '2026-12-01', to: '2026-12-14' },
  ]);
});

test('several blackouts can be listed', () => {
  assert.equal(parseBlackouts('2026-12, 2027-03-05, 2027-07-01..2027-07-14').length, 3);
});

test('a malformed blackout throws rather than being ignored', () => {
  // Silently dropping one would book an appointment for a day you are away.
  assert.throws(() => parseBlackouts('December'), /Cannot read blackout/);
  assert.throws(() => parseBlackouts('2026-12-01..'), /Cannot read blackout/);
  assert.throws(() => parseBlackouts('26-12'), /Cannot read blackout/);
});

test('no blackouts is not an error', () => {
  assert.deepEqual(parseBlackouts(''), []);
  assert.deepEqual(parseBlackouts(undefined), []);
});

test('a blacked-out date is never chosen', () => {
  const guards = { ...window2026, blackouts: parseBlackouts('2026-12') };
  assert.equal(chooseDate(offered('2026-12-10'), guards), null);
});

test('the day after a blackout ends is fair game', () => {
  const guards = { earliest: '2026-09-01', latest: '2027-06-30', blackouts: parseBlackouts('2026-12') };
  assert.equal(chooseDate(offered('2026-12-10', '2027-01-04'), guards).iso, '2027-01-04');
});

test('blackout edges are inclusive', () => {
  const guards = { earliest: '2026-09-01', latest: '2027-06-30', blackouts: parseBlackouts('2026-12') };
  assert.equal(chooseDate(offered('2026-12-01'), guards), null);
  assert.equal(chooseDate(offered('2026-12-31'), guards), null);
  assert.equal(chooseDate(offered('2026-11-30'), guards).iso, '2026-11-30');
  assert.equal(chooseDate(offered('2027-01-01'), guards).iso, '2027-01-01');
});

test('a blackout does not discard dates after it, the way a narrow window would', () => {
  // The whole point: "away in December" must not mean "never book after November".
  const guards = { earliest: '2026-09-01', latest: '2027-06-30', blackouts: parseBlackouts('2026-12') };
  assert.equal(chooseDate(offered('2026-12-15', '2027-02-03'), guards).iso, '2027-02-03');
});

test('a skip explains the blackout it applied', () => {
  const guards = { ...window2026, blackouts: parseBlackouts('2026-12') };
  assert.match(explainSkip(offered('2026-12-10'), guards), /not during 2026-12-01\.\.2026-12-31/);
});
