import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inQuietHours, nextDelaySeconds } from '../src/pacing.mjs';

const base = {
  intervalSeconds: 300,
  jitterSeconds: 60,
  maxChecksPerHour: 20,
  quietHoursStart: -1,
  quietHoursEnd: -1,
};

test('quiet hours are off unless configured', () => {
  assert.equal(inQuietHours(base, new Date('2026-01-01T03:00:00')), false);
});

test('an overnight window wraps past midnight', () => {
  const config = { ...base, quietHoursStart: 22, quietHoursEnd: 7 };
  assert.equal(inQuietHours(config, new Date('2026-01-01T23:30:00')), true);
  assert.equal(inQuietHours(config, new Date('2026-01-01T03:00:00')), true);
  assert.equal(inQuietHours(config, new Date('2026-01-01T12:00:00')), false);
});

test('a same-day window does not wrap', () => {
  const config = { ...base, quietHoursStart: 1, quietHoursEnd: 6 };
  assert.equal(inQuietHours(config, new Date('2026-01-01T03:00:00')), true);
  assert.equal(inQuietHours(config, new Date('2026-01-01T23:00:00')), false);
});

test('a healthy check waits the base interval plus jitter', () => {
  assert.equal(nextDelaySeconds(base, 0, () => 0), 300);
  assert.equal(nextDelaySeconds(base, 0, () => 1), 360);
});

test('failures back off geometrically and cap at an hour', () => {
  assert.equal(nextDelaySeconds(base, 1, () => 0), 600);
  assert.equal(nextDelaySeconds(base, 2, () => 0), 1200);
  assert.equal(nextDelaySeconds(base, 10, () => 0), 3600);
});

test('the hourly cap raises the floor above a too-short interval', () => {
  // 6 checks/hour means no less than 600s apart, whatever the interval says.
  const config = { ...base, intervalSeconds: 300, maxChecksPerHour: 6 };
  assert.equal(nextDelaySeconds(config, 0, () => 0), 600);
});
