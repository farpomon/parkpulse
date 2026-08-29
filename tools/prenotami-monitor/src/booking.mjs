// Taking a slot.
//
// This is the only module that changes anything on the consulate's side, so it
// is deliberately the most suspicious code in the project. Its rules:
//
//   * It books nothing outside the date window in your .env.
//   * It never answers a CAPTCHA. A bot check ends the attempt and calls you.
//   * It never invents a value for a form field. If the booking form asks for
//     something your profile did not already fill in, it stops and calls you.
//     Guessing on a government form is a worse outcome than missing a slot.
//   * It records the exact text of every consent box it ticks, so what was
//     agreed to in your name is in the log and in the alert.
//   * It books once. After a success it writes a flag and stops watching.
//
// Selectors below are best-effort against a site this project cannot reach from
// CI. Run `npm run probe` and one `PRENOTAMI_BOOK_DRY_RUN=true` cycle before
// arming this. See README, "Before you arm it".

import { join } from 'node:path';
import { chooseDate, explainSkip } from './dates.mjs';
import { looksLikeChallenge } from './session.mjs';

// jQuery UI datepicker, which is what prenotami renders. Selectable days carry
// data-handler="selectDay"; blocked days get .ui-datepicker-unselectable.
const DAY_CELL = 'td[data-handler="selectDay"]:not(.ui-datepicker-unselectable)';

export async function extractCandidateDates(page) {
  return page
    .locator(DAY_CELL)
    .evaluateAll((cells) =>
      cells
        .map((cell) => {
          // data-month is 0-indexed, as jQuery UI has always had it.
          const year = Number(cell.getAttribute('data-year'));
          const month = Number(cell.getAttribute('data-month'));
          const day = Number(cell.textContent.trim());
          if (!Number.isFinite(year) || !Number.isFinite(month) || !day) return null;
          const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          return { iso, label: cell.textContent.trim() };
        })
        .filter(Boolean)
    )
    .catch(() => []);
}

// Any visible, required, still-empty field. The presence of one of these is a
// stop condition, not a prompt to be clever.
async function unfilledRequiredFields(page) {
  return page
    .locator('input[required], select[required], textarea[required]')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          if (node.offsetParent === null) return false; // hidden
          if (node.type === 'checkbox' || node.type === 'radio') return false; // handled below
          return !String(node.value || '').trim();
        })
        .map(
          (node) =>
            node.name ||
            node.id ||
            node.getAttribute('placeholder') ||
            node.tagName.toLowerCase()
        )
    )
    .catch(() => []);
}

// Ticks required consent boxes and reports exactly what each one said, so the
// alert can tell you what was agreed to on your behalf.
async function acceptRequiredConsents(page) {
  const boxes = page.locator('input[type="checkbox"][required]');
  const accepted = [];

  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    if (!(await box.isVisible().catch(() => false))) continue;
    if (await box.isChecked().catch(() => false)) continue;

    const label = await box
      .evaluate((node) => {
        const byFor = node.id && document.querySelector(`label[for="${node.id}"]`);
        const wrapping = node.closest('label');
        const text = (byFor || wrapping || node.parentElement)?.innerText || '';
        return text.replace(/\s+/g, ' ').trim().slice(0, 200);
      })
      .catch(() => '');

    await box.check({ timeout: 5000 }).catch(() => {});
    accepted.push(label || '(unlabelled checkbox)');
  }
  return accepted;
}

async function firstAvailableTimeSlot(page) {
  // Some services show a time dropdown after the date; many show none at all.
  const select = page.locator('select[name*="lot" i], select[name*="ora" i], select#slot').first();
  if (await select.count()) {
    const values = await select
      .locator('option')
      .evaluateAll((options) =>
        options
          .filter((option) => option.value && !option.disabled)
          .map((option) => ({ value: option.value, label: option.textContent.trim() }))
      )
      .catch(() => []);
    if (values.length) {
      await select.selectOption(values[0].value).catch(() => {});
      return values[0].label;
    }
  }
  return null;
}

/**
 * Attempts to take a slot on an already-open booking page.
 * Returns { booked, outcome, detail, ... } and never throws for site behaviour.
 */
export async function attemptBooking(page, config, logger) {
  const { booking } = config;
  const guards = {
    earliest: booking.earliest,
    latest: booking.latest,
    weekdays: booking.weekdays,
  };

  const candidates = await extractCandidateDates(page);
  const chosen = chooseDate(candidates, guards);

  if (!chosen) {
    // A slot existed and we passed on it. Say so plainly -- this is the case
    // where staying quiet would look exactly like a bug.
    return {
      booked: false,
      outcome: 'skipped',
      detail: `Did not book: ${explainSkip(candidates, guards)}.`,
      candidates: candidates.map((c) => c.iso),
    };
  }

  logger.info(`Selecting ${chosen.iso} (window ${guards.earliest}..${guards.latest})`);

  // Re-find the cell by its own date attributes rather than by position: the
  // calendar can re-render between reading it and clicking, and clicking "the
  // third green box" after a re-render books the wrong day.
  const [year, month, day] = chosen.iso.split('-').map(Number);
  const cell = page
    .locator(`${DAY_CELL}[data-year="${year}"][data-month="${month - 1}"]`)
    .filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) })
    .first();

  if (!(await cell.count())) {
    return {
      booked: false,
      outcome: 'skipped',
      detail: `${chosen.iso} was offered but vanished before it could be selected.`,
      candidates: candidates.map((c) => c.iso),
    };
  }

  await cell.click({ timeout: 10_000 });
  await page.waitForTimeout(1500);

  const timeSlot = await firstAvailableTimeSlot(page);

  if (await looksLikeChallenge(page)) {
    return {
      booked: false,
      outcome: 'challenge',
      detail: `A bot check appeared while booking ${chosen.iso}. Stopped without answering it.`,
      chosen: chosen.iso,
    };
  }

  const missing = await unfilledRequiredFields(page);
  if (missing.length) {
    return {
      booked: false,
      outcome: 'needs-human',
      detail:
        `${chosen.iso} is available, but the form needs values this tool will not ` +
        `invent: ${missing.join(', ')}. Book it yourself — the slot is open now.`,
      chosen: chosen.iso,
    };
  }

  const consents = await acceptRequiredConsents(page);
  if (consents.length) {
    logger.info(`Accepted required consents: ${consents.join(' | ')}`);
  }

  const shotBase = join(config.dataDir, `booking-${chosen.iso}-${Date.now()}`);
  await page.screenshot({ path: `${shotBase}-before-submit.png`, fullPage: true }).catch(() => {});

  if (booking.dryRun) {
    return {
      booked: false,
      outcome: 'dry-run',
      detail:
        `Dry run: would have booked ${chosen.iso}${timeSlot ? ` at ${timeSlot}` : ''}. ` +
        'Stopped before submitting. Set PRENOTAMI_BOOK_DRY_RUN=false to arm.',
      chosen: chosen.iso,
      timeSlot,
      consents,
      screenshot: `${shotBase}-before-submit.png`,
    };
  }

  const submit = page
    .locator(
      'button[type="submit"], input[type="submit"], ' +
        'button:has-text("Conferma"), button:has-text("Confirm"), button:has-text("Prenota")'
    )
    .first();

  if (!(await submit.count())) {
    return {
      booked: false,
      outcome: 'needs-human',
      detail: `Found no submit control on the booking form for ${chosen.iso}. Book it yourself.`,
      chosen: chosen.iso,
      screenshot: `${shotBase}-before-submit.png`,
    };
  }

  logger.warn(`Submitting booking for ${chosen.iso}${timeSlot ? ` at ${timeSlot}` : ''}`);
  await submit.click({ timeout: 15_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(3000);

  await page.screenshot({ path: `${shotBase}-after-submit.png`, fullPage: true }).catch(() => {});
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');

  // Confirmed bookings land on a summary page; prenotami also emails one.
  const confirmed =
    /prenotazione (confermata|effettuata)|booking confirmed|appuntamento confermato|riepilogo/i.test(
      body
    ) || /\/Services\/(Confirm|Summary|Reservation)/i.test(page.url());

  return {
    booked: confirmed,
    outcome: confirmed ? 'booked' : 'uncertain',
    detail: confirmed
      ? `Booked ${chosen.iso}${timeSlot ? ` at ${timeSlot}` : ''}. Check your email for the confirmation.`
      : `Submitted ${chosen.iso} but could not confirm it went through. Page said: ` +
        `"${body.slice(0, 200)}". Check your account before assuming either way.`,
    chosen: chosen.iso,
    timeSlot,
    consents,
    screenshot: `${shotBase}-after-submit.png`,
  };
}
