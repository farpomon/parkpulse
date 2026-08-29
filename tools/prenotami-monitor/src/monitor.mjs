// The watch loop: paced, jittered, backed off on failure, and quiet overnight.
// Pacing rules live in pacing.mjs.

import { Session } from './session.mjs';
import { runCheck } from './check.mjs';
import { notifyAll, buildMessage } from './notify.mjs';
import { loadState, saveState, shouldNotify, recordCheck } from './state.mjs';
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

  logger.info(
    `Watching for "${config.serviceLabel}" every ~${Math.round(config.intervalSeconds / 60)} min ` +
      `(+ up to ${config.jitterSeconds}s jitter). Ctrl-C to stop.`
  );

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
