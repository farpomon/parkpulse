import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, summarize, recommendSchedule, formatReport } from '../src/report.mjs';

// Builds a log of checks every 5 minutes over `days`, where `isOpen(date)`
// decides when the consulate had something on offer.
function syntheticLog(days, isOpen, from = new Date('2026-09-01T00:00:00')) {
  const lines = [];
  for (let minute = 0; minute < days * 24 * 60; minute += 5) {
    const ts = new Date(from.getTime() + minute * 60_000);
    lines.push(
      JSON.stringify({
        ts: ts.toISOString(),
        level: 'info',
        message: 'check',
        check: true,
        outcome: isOpen(ts) ? 'available' : 'unavailable',
      })
    );
  }
  return lines.join('\n');
}

const never = () => false;

test('malformed and partial lines are skipped, not fatal', () => {
  // A killed process leaves a half-written final line.
  const text = [
    JSON.stringify({ ts: '2026-09-01T10:00:00Z', outcome: 'unavailable' }),
    'not json at all',
    '{"ts":"2026-09-01T10:05:00Z","outcome":"avail',
    '',
    JSON.stringify({ ts: '2026-09-01T10:10:00Z', outcome: 'available' }),
  ].join('\n');
  assert.equal(parseLog(text).length, 2);
});

test('lines without an outcome are ignored', () => {
  const text = [
    JSON.stringify({ ts: '2026-09-01T10:00:00Z', message: 'Logged in' }),
    JSON.stringify({ ts: '2026-09-01T10:01:00Z', outcome: 'unavailable' }),
  ].join('\n');
  assert.equal(parseLog(text).length, 1);
});

test('an empty log summarizes to nothing rather than throwing', () => {
  const summary = summarize(parseLog(''));
  assert.equal(summary.totalChecks, 0);
  assert.match(formatReport(summary, recommendSchedule(summary)), /No checks logged yet/);
});

test('a clear weekly pattern is recovered', () => {
  // Truth: Tuesdays and Thursdays, 16:00-16:20.
  const log = syntheticLog(14, (d) => [2, 4].includes(d.getDay()) && d.getHours() === 16);
  const rec = recommendSchedule(summarize(parseLog(log)));

  assert.equal(rec.confident, true);
  assert.equal(rec.worthNarrowing, true);
  assert.deepEqual(rec.days, ['tue', 'thu']);
  assert.equal(rec.startHour, 15, 'starts an hour before the earliest sighting');
  assert.equal(rec.windowMinutes, 180, 'covers 15:00-18:00');
});

test('the margin covers a release seen later than it happened', () => {
  // A slot released at 16:00 may not be seen until the next check, so the
  // window has to start before the earliest sighting, not at it.
  const log = syntheticLog(14, (d) => d.getDay() === 2 && d.getHours() === 16);
  const rec = recommendSchedule(summarize(parseLog(log)));
  assert.ok(rec.startHour < 16);
});

test('two weeks of nothing recommends carrying on, not narrowing', () => {
  const rec = recommendSchedule(summarize(parseLog(syntheticLog(14, never))));
  assert.equal(rec.confident, false);
  assert.match(rec.reason, /No availability in 14/);
  assert.match(rec.reason, /continuously/);
});

test('a thin log refuses to recommend', () => {
  // Two sightings in three days is a coincidence, and a schedule built on it
  // would stop watching most of the week.
  const log = syntheticLog(3, (d) => d.getDay() === 2 && d.getHours() === 16 && d.getMinutes() < 10);
  const rec = recommendSchedule(summarize(parseLog(log)));
  assert.equal(rec.confident, false);
  assert.match(rec.reason, /too thin/);
});

test('under a week of data never recommends, however many sightings', () => {
  const log = syntheticLog(4, (d) => d.getHours() === 16);
  const rec = recommendSchedule(summarize(parseLog(log)));
  assert.equal(rec.confident, false);
});

test('availability scattered across the week is not a pattern', () => {
  // Slots on six days a week: confident about the data, but narrowing to it
  // would save nothing and risk missing the seventh.
  const log = syntheticLog(21, (d) => d.getDay() !== 0 && d.getHours() === 16);
  const rec = recommendSchedule(summarize(parseLog(log)));
  assert.equal(rec.confident, true);
  assert.equal(rec.worthNarrowing, false);
  assert.match(formatReport(summarize(parseLog(log)), rec), /not a pattern worth narrowing/);
});

test('a skipped or booked slot still counts as availability', () => {
  // The question is when the consulate released something, not what was done
  // about it. A date passed over for being in December is still a sighting.
  const text = [
    JSON.stringify({ ts: '2026-09-01T16:00:00', outcome: 'skipped' }),
    JSON.stringify({ ts: '2026-09-01T16:05:00', outcome: 'booked' }),
    JSON.stringify({ ts: '2026-09-01T16:10:00', outcome: 'needs-human' }),
    JSON.stringify({ ts: '2026-09-01T16:15:00', outcome: 'unavailable' }),
  ].join('\n');
  assert.equal(summarize(parseLog(text)).events.length, 3);
});

test('errors and bot checks are not counted as availability', () => {
  const text = [
    JSON.stringify({ ts: '2026-09-01T16:00:00', outcome: 'error' }),
    JSON.stringify({ ts: '2026-09-01T16:05:00', outcome: 'challenge' }),
    JSON.stringify({ ts: '2026-09-01T16:10:00', outcome: 'blocked' }),
  ].join('\n');
  const summary = summarize(parseLog(text));
  assert.equal(summary.events.length, 0);
  assert.equal(summary.totalChecks, 3);
});

test('the grid distinguishes "watched, nothing seen" from "never watched"', () => {
  // The difference matters: a blank hour must not read as "slots never appear
  // then" when the truth is that nothing was looking.
  const log = syntheticLog(14, (d) => d.getDay() === 2 && d.getHours() === 16, new Date('2026-09-01T00:00:00'));
  const summary = summarize(parseLog(log));
  const report = formatReport(summary, recommendSchedule(summary));
  assert.match(report, /· = watched, nothing seen/);
  assert.match(report, /blank = not watched/);
});

test('outcome counts and share are reported', () => {
  const log = syntheticLog(14, (d) => d.getDay() === 2 && d.getHours() === 16);
  const summary = summarize(parseLog(log));
  const report = formatReport(summary, recommendSchedule(summary));
  assert.match(report, /unavailable/);
  assert.match(report, /available/);
  assert.equal(summary.totalChecks, summary.byOutcome.available + summary.byOutcome.unavailable);
});
