import { setTimeout as sleep } from 'node:timers/promises';
import { isQuietHours } from './threshold.js';
import * as logger from './logger.js';

/**
 * Run a check cycle function repeatedly on an interval.
 * Uses 5-second sleep increments for responsive Ctrl+C on Windows.
 */
export async function watchLoop(runCycle, config) {
  const intervalMinutes = config.watch?.intervalMinutes ?? 10;
  const quietStart = config.watch?.quietHoursStart ?? null;
  const quietEnd = config.watch?.quietHoursEnd ?? null;
  const intervalMs = intervalMinutes * 60_000;

  logger.header(`Watch mode - checking every ${intervalMinutes} minutes`);

  // Handle graceful shutdown
  let running = true;
  const shutdown = () => {
    logger.info('Shutting down...');
    running = false;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    if (isQuietHours(quietStart, quietEnd)) {
      logger.debug(`Quiet hours (${quietStart} - ${quietEnd}), skipping cycle`);
    } else {
      try {
        await runCycle();
      } catch (err) {
        logger.error(`Cycle error: ${err.message}`);
      }
    }

    // Sleep in 5s increments for responsive shutdown
    const endTime = Date.now() + intervalMs;
    while (running && Date.now() < endTime) {
      const remaining = endTime - Date.now();
      await sleep(Math.min(5_000, remaining));
    }
  }

  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  logger.info('Watch mode stopped.');
}
