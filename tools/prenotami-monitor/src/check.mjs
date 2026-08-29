// One check: find the service row on the Services page, open its booking page,
// and decide whether anything is actually bookable.
//
// This module reads. It never clicks a date, never submits a booking form, and
// never confirms anything. Deciding to take an appointment is yours.

import { join } from 'node:path';
import { firstMatch, looksLikeChallenge } from './session.mjs';
import { classifyBookingPage } from './classify.mjs';

// Finds the anchor for the service we care about and returns its booking URL.
async function findServiceLink(page, config) {
  const links = page.locator('a[href*="/Services/Booking/"]');
  const count = await links.count();

  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    // The service name normally sits in the same table row as the Book button,
    // not in the button itself, so widen the search to the row before giving up.
    const row = link.locator('xpath=ancestor::tr[1]');
    const text =
      (await row.innerText().catch(() => '')) || (await link.innerText().catch(() => ''));

    if (config.servicePattern.test(text)) {
      const href = await link.getAttribute('href');
      return {
        url: new URL(href, config.baseUrl).toString(),
        serviceName: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      };
    }
  }
  return null;
}

export async function runCheck(session, config, logger) {
  let page;
  try {
    page = await session.authenticatedPage();

    if (await looksLikeChallenge(page)) {
      return { outcome: 'challenge', detail: 'Services page served a bot challenge' };
    }

    // Make sure the services table actually rendered before concluding the
    // service is missing -- an empty page and an absent service look alike.
    await firstMatch(page, ['a[href*="/Services/Booking/"]', 'table', '.table'], 10_000).catch(
      () => null
    );

    const service = await findServiceLink(page, config);
    if (!service) {
      const visible = await page
        .locator('a[href*="/Services/Booking/"]')
        .allInnerTexts()
        .catch(() => []);
      return {
        outcome: 'error',
        detail:
          `No service on the Services page matched ${config.servicePattern}. ` +
          `Services offered: ${visible.join(' | ').replace(/\s+/g, ' ').slice(0, 300) || '(none found)'}. ` +
          'Adjust PRENOTAMI_SERVICE_PATTERN, or run `npm run probe`.',
      };
    }

    logger.info(`Opening booking page for "${service.serviceName}"`);
    await page.goto(service.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200); // the availability notice arrives via script

    if (await looksLikeChallenge(page)) {
      return {
        outcome: 'challenge',
        bookingUrl: service.url,
        detail: 'Booking page served a bot challenge',
      };
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const { outcome, matched } = classifyBookingPage(bodyText, config);

    const result = {
      outcome,
      bookingUrl: service.url,
      serviceName: service.serviceName,
      detail: matched
        ? `Site said: "${matched}"`
        : 'No "unavailable" notice on the booking page — it is offering dates.',
    };

    // A screenshot is the difference between "the tool thinks there is a slot"
    // and "here is the page that said so", which matters at 3am.
    if (config.screenshots && outcome !== 'unavailable') {
      const shot = join(config.dataDir, `booking-${outcome}-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      result.screenshot = shot;
    }

    return result;
  } catch (error) {
    return {
      outcome: error.outcome === 'auth' ? 'error' : error.outcome || 'error',
      detail: String(error.message || error).slice(0, 500),
      fatal: error.outcome === 'auth',
    };
  } finally {
    await page?.close().catch(() => {});
  }
}
