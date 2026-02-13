import { readFileSync, writeFileSync } from 'node:fs';
import * as logger from './logger.js';

/**
 * Load history from disk. Returns [] on error or missing file.
 */
export function loadHistory(historyPath) {
  try {
    const raw = readFileSync(historyPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Append an execution record to history.json.
 */
export function appendRecord(historyPath, record) {
  const history = loadHistory(historyPath);

  history.push({
    timestamp: new Date().toISOString(),
    taskId: record.taskId,
    taskName: record.taskName,
    success: record.success,
    costUSD: record.costUSD,
    durationMs: record.durationMs,
    error: record.error || null,
  });

  try {
    writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf-8');
    logger.debug(`History updated: ${historyPath}`);
  } catch (err) {
    logger.error(`Failed to write history: ${err.message}`);
  }
}

/**
 * Get recent history entries for display.
 */
export function getRecentHistory(historyPath, count = 10) {
  const history = loadHistory(historyPath);
  return history.slice(-count).reverse().map(h => ({
    time: new Date(h.timestamp).toLocaleString(),
    task: h.taskName || h.taskId,
    status: h.success ? 'OK' : 'FAIL',
    cost: h.costUSD != null ? `$${h.costUSD.toFixed(2)}` : '-',
    duration: h.durationMs ? `${(h.durationMs / 1000).toFixed(0)}s` : '-',
  }));
}
