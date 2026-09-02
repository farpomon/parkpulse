// When to be awake.
//
// Continuous polling is the default. A schedule narrows that to specific days
// and a time of day, for the case where you know when your consulate releases
// slots and there is no point watching the rest of the week.
//
// A scheduled run is a window, not an instant. Slots released at 15:00 are gone
// by 15:10, and a single request fired at exactly 15:00:00 either catches that
// or does not. So the schedule wakes the monitor at the appointed time and lets
// it poll normally for a while, then puts it back to sleep.
//
// All times are the machine's local zone. Pure and browser-free -- see
// test/schedule.test.mjs.

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseTimeOfDay(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec((raw || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * The next moment the monitor should wake, strictly after `from`.
 * Returns null if the schedule names no days.
 */
export function nextScheduledRun(schedule, from = new Date()) {
  const { days, hour, minute } = schedule;
  if (!days?.length) return null;

  // Walk forward a day at a time and let the platform handle the calendar.
  // setHours works in local time, so a DST shift moves the wake-up with the
  // clock -- 15:00 stays 15:00 through the November change, which is what
  // "check at 3pm" means to a person.
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate > from && days.includes(WEEKDAY_NAMES[candidate.getDay()])) {
      return candidate;
    }
  }
  return null;
}

// True if `now` falls inside the active window that opened at `runStart`.
export function isWithinWindow(runStart, windowMinutes, now = new Date()) {
  if (!runStart) return false;
  const end = runStart.getTime() + windowMinutes * 60_000;
  return now.getTime() >= runStart.getTime() && now.getTime() < end;
}

export function describeSchedule(schedule) {
  if (!schedule.enabled) return 'continuously';
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  const days = schedule.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(' and ');
  return `${days} at ${time} local, polling for ${schedule.windowMinutes} min each time`;
}
