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
import { nextScheduledRun, isWithinWindow, describeSchedule } from './schedule.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A scheduled wait can be days long. Sleep in short hops so Ctrl-C is answered
// in seconds rather than on Tuesday.
async function sleepUntil(targetMs, isStopping) {
  while (!isStopping() && Date.now() < targetMs) {
    await sleep(Math.min(30_000, targetMs - Date.now()));
  }
}

function formatWait(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export async function checkOnce(config, logger, session) {
  const own = !session;
  const active = session || new Session(config, logger);
  try {
    const result = await runCheck(active, config, logger);
    const state = loadState(config.dataDir);
    const notify = shouldNotify(state, result.outcome);

    // Every check writes `outcome` and `check: true` to the log, so `report` can
    // aggregate on a field rather than parsing English out of the message.
    const logFields = { ...result, outcome: result.outcome, check: true };

    if (result.outcome === 'available') {
      logger.ok(`SLOTS OPEN — ${result.bookingUrl}`, logFields);
    } else if (result.outcome === 'unavailable') {
      logger.info('No dates available', logFields);
    } else {
      logger.warn(`${result.outcome}: ${result.detail}`, logFields);
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
    `Watching for "${config.serviceLabel}" ${describeSchedule(config.schedule)}, ` +
      `checking every ~${Math.round(config.intervalSeconds / 60)} min ` +
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

  let windowStart = null;

  while (!stopping) {
    // A schedule replaces continuous polling: sleep until the next named day
    // and time, then poll normally until the window closes.
    if (config.schedule.enabled) {
      if (!isWithinWindow(windowStart, config.schedule.windowMinutes)) {
        const next = nextScheduledRun(config.schedule);
        logger.info(
          `Sleeping until ${next.toLocaleString()} (${formatWait(next.getTime() - Date.now())} away)`
        );
        await sleepUntil(next.getTime(), () => stopping);
        if (stopping) break;
        windowStart = next;
        logger.info(`Window open — polling for ${config.schedule.windowMinutes} min`);
      }
    } else if (inQuietHours(config)) {
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

    // Do not idle inside a window that is about to close; go back to sleep and
    // let the next scheduled run open a fresh one.
    if (config.schedule.enabled) {
      const windowEnds = windowStart.getTime() + config.schedule.windowMinutes * 60_000;
      if (Date.now() + delay * 1000 >= windowEnds) {
        logger.info('Window closed');
        windowStart = null;
        continue;
      }
    }

    logger.info(`Next check in ${delay}s`);
    await sleepUntil(Date.now() + delay * 1000, () => stopping);
  }

  await session.close();
  logger.info('Stopped.');
}
