// The watch loop: paced, jittered, backed off on failure, and quiet overnight.
// Pacing rules live in pacing.mjs.

import { Session } from './session.mjs';
import { runCheck } from './check.mjs';
import { notifyAll, buildMessage } from './notify.mjs';
import {
  loadState,
  saveState,
  shouldNotify,
  recordCheck,
  shouldHeartbeat,
  recordHeartbeat,
} from './state.mjs';
import { inQuietHours, nextDelaySeconds } from './pacing.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkOnce(config, logger, session) {
  const own = !session;
  const active = session || new Session(config, logger);
  try {
    const result = await runCheck(active, config, logger);
    const state = loadState(config.dataDir);
    const notify = shouldNotify(state, result.outcome);

    if (result.outcome === 'available') {
      logger.ok(`SLOTS OPEN — ${result.bookingUrl}`, result);
    } else if (result.outcome === 'unavailable') {
      logger.info('No dates available', { detail: result.detail });
    } else {
      logger.warn(`${result.outcome}: ${result.detail}`, result);
    }

    if (notify) await notifyAll(config, logger, buildMessage(config, result));

    recordCheck(state, result.outcome, { notified: notify });

    // Latch the booking permanently. The service files restart this process on
    // exit, so without a flag on disk a successful booking would be followed by
    // a relaunch that books a second one.
    if (result.outcome === 'booked' || result.outcome === 'uncertain') {
      state.booked = {
        at: new Date().toISOString(),
        date: result.chosen || null,
        timeSlot: result.timeSlot || null,
        confirmed: result.outcome === 'booked',
      };
    }

    // Prove the monitor is still alive even when it has nothing to report.
    if (!notify && shouldHeartbeat(state, config.heartbeatHours)) {
      await notifyAll(config, logger, {
        priority: 'normal',
        title: 'prenotami monitor: still watching',
        body:
          `${state.checks} checks so far. Latest: ${result.outcome}. ` +
          'No slots yet — you will hear from me the moment there are.',
        url: `${config.baseUrl}/Services`,
      });
      recordHeartbeat(state);
    }

    saveState(state);
    return result;
  } finally {
    if (own) await active.close();
  }
}

export async function watch(config, logger) {
  const session = new Session(config, logger);
  let consecutiveFailures = 0;
  let stopping = false;

  const stop = () => {
    if (stopping) process.exit(1); // second Ctrl-C means now
    stopping = true;
    logger.info('Stopping after the current check...');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const existing = loadState(config.dataDir);
  if (existing.booked) {
    // Refuse to start rather than exit quietly: under systemd a quiet exit is
    // a restart loop, and every loop is another chance to book again.
    logger.warn(
      `Already booked ${existing.booked.date || '(unknown date)'} on ${existing.booked.at}. ` +
        'Not watching. Delete the "booked" key in data/state.json if you cancelled it ' +
        'and genuinely want to book another.'
    );
    return;
  }

  logger.info(
    `Watching for "${config.serviceLabel}" every ~${Math.round(config.intervalSeconds / 60)} min ` +
      `(+ up to ${config.jitterSeconds}s jitter). Ctrl-C to stop.`
  );
  if (config.booking.enabled) {
    logger.warn(
      config.booking.dryRun
        ? `Auto-book: DRY RUN, window ${config.booking.earliest}..${config.booking.latest}`
        : `Auto-book: ARMED, window ${config.booking.earliest}..${config.booking.latest}. ` +
          'It will book the first date in that window and stop.'
    );
  }

  while (!stopping) {
    if (inQuietHours(config)) {
      logger.info('Quiet hours — skipping this check');
      await sleep(15 * 60 * 1000);
      continue;
    }

    let result;
    try {
      result = await checkOnce(config, logger, session);
    } catch (error) {
      result = { outcome: 'error', detail: String(error.message || error) };
      logger.error(`Check threw: ${result.detail}`);
      // Drop the browser so the next attempt starts from a clean one.
      await session.close().catch(() => {});
    }

    if (result.fatal) {
      logger.error('Stopping: this will not fix itself by retrying.');
      break;
    }

    if (result.outcome === 'booked' || result.outcome === 'uncertain') {
      logger.ok('Booking attempted — stopping so it cannot happen twice.');
      break;
    }

    consecutiveFailures =
      result.outcome === 'error' || result.outcome === 'challenge' ? consecutiveFailures + 1 : 0;

    if (stopping) break;

    const delay = nextDelaySeconds(config, consecutiveFailures);
    logger.info(`Next check in ${delay}s`);
    await sleep(delay * 1000);
  }

  await session.close();
  logger.info('Stopped.');
}
