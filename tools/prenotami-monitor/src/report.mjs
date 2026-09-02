// Reading the check log back.
//
// The point of watching continuously for a week or two is to find out when your
// consulate actually releases slots, so the watching can then be narrowed. That
// only works if the log can answer the question -- scrolling a JSONL of several
// thousand lines cannot.
//
// Pure and I/O-free apart from the reader at the bottom, so the arithmetic that
// produces a recommendation is directly testable. See test/report.test.mjs.

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Outcomes that mean dates were actually on offer, whatever was done about
// them. A slot skipped for being outside the booking window still tells you the
// consulate released something at that moment, which is the question here.
const AVAILABILITY = new Set(['available', 'booked', 'skipped', 'needs-human', 'dry-run', 'uncertain']);

// Below this, "Tuesdays at 3" is describing noise rather than a pattern.
const MIN_EVENTS_TO_RECOMMEND = 3;

export function parseLog(text) {
  const entries = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Older logs predate the `check` field; fall back to the presence of an
      // outcome so a log started before this feature still reports.
      if (entry.outcome) entries.push(entry);
    } catch {
      // A truncated final line is normal if the process was killed mid-write.
    }
  }
  return entries;
}

export function summarize(entries, now = new Date()) {
  const checks = entries.filter((e) => e.outcome);
  const events = checks.filter((e) => AVAILABILITY.has(e.outcome));

  const byOutcome = {};
  for (const check of checks) byOutcome[check.outcome] = (byOutcome[check.outcome] || 0) + 1;

  // Local time throughout: the schedule you will write is in local time, so a
  // report in UTC would be answering a different question than the one asked.
  const grid = [];
  for (const event of events) {
    const at = new Date(event.ts);
    if (Number.isNaN(at.getTime())) continue;
    grid.push({ weekday: at.getDay(), hour: at.getHours(), ts: event.ts, outcome: event.outcome });
  }

  const timestamps = checks.map((c) => new Date(c.ts)).filter((d) => !Number.isNaN(d.getTime()));
  const first = timestamps.length ? new Date(Math.min(...timestamps)) : null;
  const last = timestamps.length ? new Date(Math.max(...timestamps)) : null;
  const spanDays = first && last ? (last - first) / 86_400_000 : 0;

  return {
    totalChecks: checks.length,
    byOutcome,
    events: grid,
    first,
    last,
    spanDays,
    coverage: coverageByHour(checks),
  };
}

// How many checks landed in each weekday/hour cell. Without this, an hour with
// no sightings is ambiguous: nothing was released, or nothing was watching.
function coverageByHour(checks) {
  const cells = new Map();
  for (const check of checks) {
    const at = new Date(check.ts);
    if (Number.isNaN(at.getTime())) continue;
    const key = `${at.getDay()}:${at.getHours()}`;
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  return cells;
}

/**
 * Turns observed availability into schedule settings, or declines to.
 * Never recommends narrowing on thin evidence: a schedule built from two
 * sightings stops watching six days a week on the strength of a coincidence.
 */
export function recommendSchedule(summary) {
  const { events, spanDays } = summary;

  if (events.length === 0) {
    return {
      confident: false,
      reason:
        spanDays < 7
          ? `No availability seen yet, and only ${spanDays.toFixed(1)} days of log. Keep watching continuously.`
          : `No availability in ${spanDays.toFixed(1)} days of watching. Nothing to narrow to — keep watching continuously.`,
    };
  }

  if (events.length < MIN_EVENTS_TO_RECOMMEND || spanDays < 7) {
    return {
      confident: false,
      reason:
        `Only ${events.length} sighting${events.length === 1 ? '' : 's'} over ` +
        `${spanDays.toFixed(1)} days. That is too thin to narrow on — a schedule built ` +
        'from it would stop watching most of the week on a coincidence. Keep going.',
      events,
    };
  }

  const weekdays = [...new Set(events.map((e) => e.weekday))].sort();
  const hours = events.map((e) => e.hour);
  const earliestHour = Math.min(...hours);
  const latestHour = Math.max(...hours);

  // Start an hour early and end an hour late: the log records when a slot was
  // *seen*, which is at best the release time and at worst a full interval after.
  const startHour = Math.max(0, earliestHour - 1);
  const endHour = Math.min(23, latestHour + 1);
  const windowMinutes = (endHour - startHour + 1) * 60;

  const daysCovered = new Set(events.map((e) => e.weekday)).size;
  return {
    confident: true,
    days: weekdays.map((d) => WEEKDAY_NAMES[d]),
    dayLabels: weekdays.map((d) => WEEKDAY_LABELS[d]),
    startHour,
    windowMinutes,
    eventCount: events.length,
    spanDays,
    // Narrowing to fewer than every day is only meaningful if the sightings
    // actually cluster; sightings on six of seven days are not a pattern.
    worthNarrowing: daysCovered <= 4,
  };
}

export function formatReport(summary, recommendation) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);

  if (summary.totalChecks === 0) {
    return 'No checks logged yet. Run `npm run watch` for a week or two, then come back.';
  }

  lines.push('');
  lines.push(
    `${summary.totalChecks} checks over ${summary.spanDays.toFixed(1)} days ` +
      `(${summary.first.toLocaleString()} → ${summary.last.toLocaleString()})`
  );
  lines.push('');

  lines.push('Outcomes');
  for (const [outcome, count] of Object.entries(summary.byOutcome).sort((a, b) => b[1] - a[1])) {
    const share = ((count / summary.totalChecks) * 100).toFixed(1);
    lines.push(`  ${pad(outcome, 14)} ${String(count).padStart(6)}  ${share.padStart(5)}%`);
  }
  lines.push('');

  if (summary.events.length === 0) {
    lines.push('No availability seen in this log.');
  } else {
    lines.push(`Availability seen ${summary.events.length} times, by local hour:`);
    lines.push('');
    lines.push(`      ${WEEKDAY_LABELS.map((d) => pad(d, 4)).join('')}`);

    const seen = new Map();
    for (const event of summary.events) {
      const key = `${event.weekday}:${event.hour}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }

    for (let hour = 0; hour < 24; hour += 1) {
      const row = [];
      let any = false;
      for (let day = 0; day < 7; day += 1) {
        const hits = seen.get(`${day}:${hour}`) || 0;
        const watched = summary.coverage.get(`${day}:${hour}`) || 0;
        if (hits) any = true;
        // "·" means watched and nothing found; blank means never watched there,
        // which is a different fact and must not read as "nothing happens then".
        row.push(pad(hits ? String(hits) : watched ? '·' : ' ', 4));
      }
      if (any || summary.events.some((e) => Math.abs(e.hour - hour) <= 1)) {
        lines.push(`${String(hour).padStart(4)}  ${row.join('')}`);
      }
    }
    lines.push('');
    lines.push('  n = times availability was seen   · = watched, nothing seen   blank = not watched');
  }

  lines.push('');
  if (recommendation.confident && recommendation.worthNarrowing) {
    const time = `${String(recommendation.startHour).padStart(2, '0')}:00`;
    lines.push(`Suggested schedule, from ${recommendation.eventCount} sightings:`);
    lines.push('');
    lines.push(`  PRENOTAMI_SCHEDULE_DAYS=${recommendation.days.join(',')}`);
    lines.push(`  PRENOTAMI_SCHEDULE_TIME=${time}`);
    lines.push(`  PRENOTAMI_SCHEDULE_WINDOW_MINUTES=${recommendation.windowMinutes}`);
    lines.push('');
    lines.push(
      `  Covers every sighting so far, with an hour's margin either side. ` +
        `Everything outside it stops being watched — re-run this after a few weeks on the ` +
        'narrowed schedule to check you are not missing releases.'
    );
  } else if (recommendation.confident) {
    lines.push(
      `Availability turned up on ${recommendation.dayLabels.length} different days ` +
        `(${recommendation.dayLabels.join(', ')}). That is not a pattern worth narrowing to — ` +
        'keep watching continuously.'
    );
  } else {
    lines.push(recommendation.reason);
  }
  lines.push('');

  return lines.join('\n');
}
