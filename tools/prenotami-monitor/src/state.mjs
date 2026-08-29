// Remembers what the last check saw, so a slot that stays open for an hour
// alerts once rather than twelve times -- and so a login failure that persists
// nags once, not forever.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EMPTY = {
  lastOutcome: null,
  lastNotifiedAt: null,
  lastNotifiedOutcome: null,
  lastHeartbeatAt: null,
  checks: 0,
};

export function loadState(dataDir) {
  const path = join(dataDir, 'state.json');
  try {
    return { path, ...EMPTY, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, ...EMPTY };
  }
}

export function saveState(state) {
  const { path, ...rest } = state;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(rest, null, 2));
}

// How long to stay quiet about a condition we have already reported.
const REMIND_AFTER_MS = {
  available: 30 * 60 * 1000, // keep nudging while a slot is actually open
  blocked: 24 * 60 * 60 * 1000,
  error: 6 * 60 * 60 * 1000,
  challenge: 6 * 60 * 60 * 1000,
  // A slot that is open but unbookable by this tool is the most time-critical
  // thing it can say, so it repeats often until the situation changes.
  'needs-human': 10 * 60 * 1000,
  skipped: 30 * 60 * 1000,
};

// Alert when the situation changes, or when a still-true alarming condition has
// gone unmentioned long enough to be worth repeating. "No slots" is never worth
// an alert on its own.
//
// The transition check below is load-bearing: slots can open, get taken, and
// open again within minutes. Comparing only against what we last *notified*
// would swallow the second opening as a duplicate, which is the one failure
// this whole tool exists to prevent.
export function shouldNotify(state, outcome, now = Date.now()) {
  if (outcome === 'unavailable') return false;

  if (state.lastOutcome !== outcome) return true;
  if (state.lastNotifiedOutcome !== outcome) return true;

  const remindAfter = REMIND_AFTER_MS[outcome];
  if (!remindAfter) return false;
  if (!state.lastNotifiedAt) return true;
  return now - new Date(state.lastNotifiedAt).getTime() >= remindAfter;
}

export function recordCheck(state, outcome, { notified, now = Date.now() } = {}) {
  state.lastOutcome = outcome;
  state.lastCheckedAt = new Date(now).toISOString();
  state.checks = (state.checks || 0) + 1;
  if (notified) {
    state.lastNotifiedAt = new Date(now).toISOString();
    state.lastNotifiedOutcome = outcome;
  }
  return state;
}

// Running unattended, "no alerts" and "the process died three weeks ago" look
// identical from the outside. A periodic all-quiet message tells them apart, so
// a monitor that silently stopped is noticed in a day rather than a month.
export function shouldHeartbeat(state, intervalHours, now = Date.now()) {
  if (!intervalHours || intervalHours <= 0) return false;
  if (!state.lastHeartbeatAt) return true;
  return now - new Date(state.lastHeartbeatAt).getTime() >= intervalHours * 3600 * 1000;
}

export function recordHeartbeat(state, now = Date.now()) {
  state.lastHeartbeatAt = new Date(now).toISOString();
  return state;
}
