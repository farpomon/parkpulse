import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redact } from '../src/config.mjs';

const base = { PRENOTAMI_EMAIL: 'me@example.com', PRENOTAMI_PASSWORD: 'hunter2' };

test('missing credentials fail loudly', () => {
  assert.throws(() => loadConfig({}), /PRENOTAMI_EMAIL and PRENOTAMI_PASSWORD/);
});

test('an aggressive poll interval is refused', () => {
  // The floor exists because a flagged account cannot book at all.
  assert.throws(
    () => loadConfig({ ...base, PRENOTAMI_INTERVAL_SECONDS: '5' }),
    /Raise the value/
  );
});

test('overrides are read from the env passed in, not the ambient one', () => {
  const config = loadConfig({ ...base, PRENOTAMI_INTERVAL_SECONDS: '900' });
  assert.equal(config.intervalSeconds, 900);
});

test('the default pattern matches how Vancouver spells the service', () => {
  const { servicePattern } = loadConfig(base);
  for (const spelling of ["Carta d'identità", 'Carta d’identita', 'CARTA DI IDENTITA']) {
    assert.ok(servicePattern.test(spelling), `should match ${spelling}`);
  }
  assert.ok(!servicePattern.test('Passaporto'));
});

test('logs never carry the password, token, or full email', () => {
  const config = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '123:SECRETTOKEN' });
  const line = redact('POST 123:SECRETTOKEN as me@example.com pw=hunter2', config);
  assert.ok(!line.includes('hunter2'));
  assert.ok(!line.includes('SECRETTOKEN'));
  assert.ok(!line.includes('me@example.com'));
  assert.ok(line.includes('@example.com'), 'domain may stay, for recognizability');
});

test('auto-booking is off unless explicitly turned on', () => {
  assert.equal(loadConfig(base).booking.enabled, false);
});

test('arming without a date window is refused', () => {
  assert.throws(
    () => loadConfig({ ...base, PRENOTAMI_AUTOBOOK: 'true' }),
    /date window would take any date/
  );
  assert.throws(
    () => loadConfig({ ...base, PRENOTAMI_AUTOBOOK: 'true', PRENOTAMI_BOOK_EARLIEST: '2026-09-01' }),
    /both required/
  );
});

test('a backwards date window is refused', () => {
  assert.throws(
    () =>
      loadConfig({
        ...base,
        PRENOTAMI_AUTOBOOK: 'true',
        PRENOTAMI_BOOK_EARLIEST: '2026-12-31',
        PRENOTAMI_BOOK_LATEST: '2026-09-01',
      }),
    /is after/
  );
});

test('a non-ISO date window is refused', () => {
  assert.throws(
    () =>
      loadConfig({
        ...base,
        PRENOTAMI_AUTOBOOK: 'true',
        PRENOTAMI_BOOK_EARLIEST: '01/09/2026',
        PRENOTAMI_BOOK_LATEST: '31/12/2026',
      }),
    /YYYY-MM-DD/
  );
});

test('a valid arming config comes through intact', () => {
  const { booking } = loadConfig({
    ...base,
    PRENOTAMI_AUTOBOOK: 'true',
    PRENOTAMI_BOOK_EARLIEST: '2026-09-01',
    PRENOTAMI_BOOK_LATEST: '2026-12-31',
    PRENOTAMI_BOOK_WEEKDAYS: 'mon,wed',
  });
  assert.equal(booking.enabled, true);
  assert.equal(booking.dryRun, false);
  assert.deepEqual(booking.weekdays, ['mon', 'wed']);
});
