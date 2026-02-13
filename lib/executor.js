import { execFileSync } from 'node:child_process';
import * as logger from './logger.js';

const SHELL = process.platform === 'win32';

/**
 * Execute a task via `claude -p`.
 * Returns { success, result, costUSD, durationMs, error }.
 */
export function executeTask(task, config) {
  const args = ['-p', task.prompt, '--output-format', 'json'];

  if (task.projectDir) {
    args.push('--project-dir', task.projectDir);
  }

  const model = task.model || config.execution?.model;
  if (model) {
    args.push('--model', model);
  }

  const allowedTools = task.allowedTools || config.execution?.defaultAllowedTools;
  if (allowedTools) {
    args.push('--allowedTools', allowedTools);
  }

  if (task.maxBudgetUSD) {
    args.push('--max-budget-usd', String(task.maxBudgetUSD));
  }

  logger.info(`Executing: claude ${args.slice(0, 4).join(' ')}...`);
  logger.debug(`Full args: claude ${args.join(' ')}`);

  const startTime = Date.now();

  try {
    const raw = execFileSync('claude', args, {
      encoding: 'utf-8',
      timeout: 30 * 60_000, // 30 minute timeout
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      shell: SHELL,
    });

    const durationMs = Date.now() - startTime;
    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = { rawOutput: raw.slice(0, 5000) };
    }

    const costUSD = result.cost_usd ?? result.costUSD ?? result.usage?.cost ?? null;

    logger.success(`Task completed in ${(durationMs / 1000).toFixed(1)}s`);

    return {
      success: true,
      result,
      costUSD,
      durationMs,
      error: null,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    // execFileSync throws on non-zero exit
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    const message = stderr || err.message;

    logger.error(`Task failed after ${(durationMs / 1000).toFixed(1)}s: ${message.slice(0, 200)}`);

    return {
      success: false,
      result: stdout ? { rawOutput: stdout.slice(0, 5000) } : null,
      costUSD: null,
      durationMs,
      error: message.slice(0, 1000),
    };
  }
}
