// How often to look. Kept free of the browser so it can be tested directly.
//
// Restraint here is not politeness for its own sake: prenotami rate-limits and
// suspends accounts that poll aggressively, and a suspended account cannot book
// the appointment you are waiting for.

export function inQuietHours(config, date = new Date()) {
  const { quietHoursStart: start, quietHoursEnd: end } = config;
  if (start < 0 || end < 0 || start === end) return false;
  const hour = date.getHours();
  // A window like 22->7 wraps past midnight.
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// Base interval plus jitter, so repeated runs never form a detectable pattern.
// Consecutive failures back off geometrically and cap at an hour.
export function nextDelaySeconds(config, consecutiveFailures, random = Math.random) {
  const floor = Math.max(config.intervalSeconds, 3600 / Math.max(config.maxChecksPerHour, 1));
  const backoff = Math.min(2 ** consecutiveFailures, 12);
  const jitter = Math.round(random() * config.jitterSeconds);
  return Math.min(Math.round(floor * backoff) + jitter, 3600);
}
