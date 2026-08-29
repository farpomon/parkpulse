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
