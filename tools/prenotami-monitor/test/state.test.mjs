import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, recordCheck, shouldHeartbeat, recordHeartbeat } from '../src/state.mjs';

const fresh = () => ({ path: '/dev/null', lastNotifiedAt: null, lastNotifiedOutcome: null });

test('"no dates" never alerts', () => {
  assert.equal(shouldNotify(fresh(), 'unavailable'), false);
});

test('the first open slot alerts', () => {
  assert.equal(shouldNotify(fresh(), 'available'), true);
});

test('a still-open slot does not re-alert immediately', () => {
  const now = Date.now();
  const state = recordCheck(fresh(), 'available', { notified: true, now });
  assert.equal(shouldNotify(state, 'available', now + 60_000), false);
});

test('a slot still open after half an hour is worth a nudge', () => {
  const now = Date.now();
  const state = recordCheck(fresh(), 'available', { notified: true, now });
  assert.equal(shouldNotify(state, 'available', now + 31 * 60_000), true);
});

test('slots closing then reopening alerts again', () => {
  // The expensive case: a slot opens, is taken, and reopens minutes later.
  // Deduplicating on "we already said available" would lose the second one.
  const now = Date.now();
  const state = recordCheck(fresh(), 'available', { notified: true, now });
  recordCheck(state, 'unavailable', { notified: false, now: now + 5 * 60_000 });
  assert.equal(shouldNotify(state, 'available', now + 10 * 60_000), true);
});

test('an unchanged open slot still does not re-alert every cycle', () => {
  const now = Date.now();
  const state = recordCheck(fresh(), 'available', { notified: true, now });
  recordCheck(state, 'available', { notified: false, now: now + 5 * 60_000 });
  assert.equal(shouldNotify(state, 'available', now + 6 * 60_000), false);
});

test('a persistent error nags once, not every cycle', () => {
  const now = Date.now();
  const state = recordCheck(fresh(), 'error', { notified: true, now });
  assert.equal(shouldNotify(state, 'error', now + 60 * 60_000), false);
  assert.equal(shouldNotify(state, 'error', now + 7 * 60 * 60_000), true);
});

test('the first run sends an all-quiet heartbeat', () => {
  assert.equal(shouldHeartbeat(fresh(), 24), true);
});

test('heartbeats respect their interval', () => {
  const now = Date.now();
  const state = recordHeartbeat(fresh(), now);
  assert.equal(shouldHeartbeat(state, 24, now + 23 * 3600_000), false);
  assert.equal(shouldHeartbeat(state, 24, now + 25 * 3600_000), true);
});

test('heartbeats can be turned off', () => {
  assert.equal(shouldHeartbeat(fresh(), 0), false);
});
