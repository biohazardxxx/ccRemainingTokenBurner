import { execFileSync } from 'node:child_process';
import * as logger from './logger.js';

const SHELL = process.platform === 'win32';

/**
 * Fetch the active billing block from ccusage.
 * Returns null if no active block or ccusage is unavailable.
 */
export function getActiveBlock() {
  try {
    const raw = execFileSync('ccusage', ['blocks', '--active', '--json'], {
      encoding: 'utf-8',
      timeout: 30_000,
      windowsHide: true,
      shell: SHELL,
    });
    const data = JSON.parse(raw);

    // ccusage wraps in { blocks: [...] } or returns a plain array
    const blocks = data.blocks || (Array.isArray(data) ? data : [data]);
    const block = blocks[0];
    if (!block) {
      logger.debug('ccusage returned no active block');
      return null;
    }

    return normalizeBlock(block);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.error('ccusage not found. Install it: npm i -g ccusage');
    } else {
      logger.error(`Failed to fetch active block: ${err.message}`);
    }
    return null;
  }
}

/**
 * Normalize block data into a consistent shape.
 */
function normalizeBlock(block) {
  const start = new Date(block.startTime || block.start || block.blockStart);
  const end = new Date(block.endTime || block.end || block.blockEnd);
  const now = new Date();
  const remainingMs = Math.max(0, end.getTime() - now.getTime());
  const remainingMinutes = block.projection?.remainingMinutes ?? remainingMs / 60_000;
  const totalCost = block.costUSD ?? block.totalCost ?? block.cost ?? 0;

  return {
    start,
    end,
    remainingMinutes: Math.round(remainingMinutes * 10) / 10,
    totalCost: typeof totalCost === 'number' ? totalCost : parseFloat(totalCost) || 0,
    raw: block,
  };
}
