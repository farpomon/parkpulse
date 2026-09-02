// Choosing which offered date to take.
//
// Pure and browser-free on purpose: these are the rules that decide what gets
// booked in your name, so they are the rules that most need to be readable and
// directly testable. See test/dates.test.mjs.

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  // Parsed as UTC noon so a machine in any timezone reads the same calendar day
  // -- a date that shifts by one under a DST boundary is a wrong appointment.
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Dates you cannot attend, as "YYYY-MM" for a whole month, "YYYY-MM-DD" for one
// day, or "YYYY-MM-DD..YYYY-MM-DD" for a span. Comma-separated.
//
// This exists because a window cannot say "any time except December". Narrowing
// LATEST to November would also discard every date after it, which is a
// different instruction and a worse one.
export function parseBlackouts(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const span = entry.split('..').map((s) => s.trim());
      if (span.length === 2 && span.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
        return span[0] <= span[1] ? { from: span[0], to: span[1] } : { from: span[1], to: span[0] };
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry)) return { from: entry, to: entry };
      if (/^\d{4}-\d{2}$/.test(entry)) {
        const [year, month] = entry.split('-').map(Number);
        // Day 0 of the next month is the last day of this one.
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return { from: `${entry}-01`, to: `${entry}-${String(lastDay).padStart(2, '0')}` };
      }
      throw new Error(
        `Cannot read blackout "${entry}". Use YYYY-MM, YYYY-MM-DD, or ` +
          'YYYY-MM-DD..YYYY-MM-DD, comma-separated.'
      );
    });
}

export function isBlackedOut(iso, blackouts = []) {
  return blackouts.some((range) => iso >= range.from && iso <= range.to);
}

export function describeBlackouts(blackouts = []) {
  return blackouts
    .map((range) => (range.from === range.to ? range.from : `${range.from}..${range.to}`))
    .join(', ');
}

// A candidate is { iso, label }. Guards come from .env.
// Returns the earliest candidate clearing every guard, or null.
export function chooseDate(candidates, guards = {}) {
  const { earliest, latest, weekdays, blackouts } = guards;

  // A window is mandatory when booking is armed (config.mjs enforces it). If it
  // is somehow missing here, take nothing rather than everything.
  if (!earliest || !latest) return null;

  const eligible = (candidates || [])
    .map((candidate) => ({ ...candidate, date: parseIsoDate(candidate.iso) }))
    .filter((candidate) => {
      if (!candidate.date) return false;
      if (candidate.iso < earliest) return false;
      if (candidate.iso > latest) return false;
      if (weekdays?.length && !weekdays.includes(WEEKDAY_NAMES[candidate.date.getUTCDay()])) {
        return false;
      }
      if (isBlackedOut(candidate.iso, blackouts)) return false;
      return true;
    })
    .sort((a, b) => a.iso.localeCompare(b.iso));

  return eligible[0] || null;
}

// Why nothing was taken, in words worth reading on a phone. A slot that opened
// and was deliberately skipped has to say so -- staying quiet there is
// indistinguishable from a bug, and you would never know you missed one.
export function explainSkip(candidates, guards = {}) {
  if (!candidates?.length) return 'the page offered no selectable dates';

  const offered = candidates.map((c) => c.iso).sort();
  const window = [
    guards.earliest ? `on or after ${guards.earliest}` : null,
    guards.latest ? `on or before ${guards.latest}` : null,
    guards.weekdays?.length ? `on a ${guards.weekdays.join('/')}` : null,
    guards.blackouts?.length ? `and not during ${describeBlackouts(guards.blackouts)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return `it offered ${offered.join(', ')} — you asked for dates ${window || '(no window set)'}`;
}

export function parseWeekdays(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().slice(0, 3).toLowerCase())
    .filter((s) => WEEKDAY_NAMES.includes(s));
}
