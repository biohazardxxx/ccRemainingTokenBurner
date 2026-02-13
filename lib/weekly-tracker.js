import { execFileSync } from 'node:child_process';
import * as logger from './logger.js';

const SHELL = process.platform === 'win32';

const DAY_MAP = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Get the start of the current week based on the configured start day.
 */
export function getWeekStart(startDay = 'monday') {
  const dayNum = DAY_MAP[startDay.toLowerCase()] ?? 1;
  const now = new Date();
  const current = now.getDay();
  const diff = (current - dayNum + 7) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diff);
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

/**
 * Fetch weekly cost from ccusage blocks since the week start.
 * Returns total cost in USD.
 */
export function getWeeklyCost(startDay = 'monday') {
  const weekStart = getWeekStart(startDay);
  // ccusage requires YYYYMMDD format
  const sinceStr = weekStart.toISOString().split('T')[0].replace(/-/g, '');

  try {
    const raw = execFileSync('ccusage', ['blocks', '--json', '--since', sinceStr], {
      encoding: 'utf-8',
      timeout: 30_000,
      windowsHide: true,
      shell: SHELL,
    });
    const data = JSON.parse(raw);

    // ccusage wraps in { blocks: [...] } or returns a plain array
    const blocks = data.blocks || (Array.isArray(data) ? data : []);

    if (!Array.isArray(blocks)) {
      logger.debug('ccusage weekly blocks response is not an array');
      return 0;
    }

    const total = blocks.reduce((sum, block) => {
      const cost = block.costUSD ?? block.totalCost ?? block.cost ?? 0;
      return sum + (typeof cost === 'number' ? cost : parseFloat(cost) || 0);
    }, 0);

    return Math.round(total * 100) / 100;
  } catch (err) {
    logger.error(`Failed to fetch weekly cost: ${err.message}`);
    return 0;
  }
}
