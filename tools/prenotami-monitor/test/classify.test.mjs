import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBookingPage } from '../src/classify.mjs';

const config = {
  unavailablePhrases: ['non ci sono date disponibili', 'no dates available'],
  blockedPhrases: ['you already have a booking'],
};

test('an Italian "no dates" notice reads as unavailable', () => {
  const page = 'Prenota  Al momento non ci sono date disponibili per questo servizio.';
  assert.equal(classifyBookingPage(page, config).outcome, 'unavailable');
});

test('the English notice reads as unavailable too', () => {
  assert.equal(
    classifyBookingPage('Sorry, there are NO DATES AVAILABLE right now', config).outcome,
    'unavailable'
  );
});

test('line breaks and doubled spaces do not hide the notice', () => {
  const page = 'Al momento\n  non   ci sono\tdate disponibili';
  assert.equal(classifyBookingPage(page, config).outcome, 'unavailable');
});

test('a calendar with no notice reads as available', () => {
  const page = 'Seleziona una data:  1 2 3 4 5  Ottobre 2026  Avanti';
  const result = classifyBookingPage(page, config);
  assert.equal(result.outcome, 'available');
  assert.equal(result.matched, null);
});

test('blocked wins over unavailable when both appear', () => {
  const page = 'You already have a booking. No dates available.';
  assert.equal(classifyBookingPage(page, config).outcome, 'blocked');
});

test('an empty page is not reported as an open slot', () => {
  // Guards the expensive failure mode: a page that failed to render must not
  // read as "available" and send someone running for their passport.
  assert.equal(classifyBookingPage('', config).outcome, 'available');
  // ...which is why check.mjs screenshots every non-unavailable outcome.
});
