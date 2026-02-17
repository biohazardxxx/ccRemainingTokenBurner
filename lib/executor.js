import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');

const SHELL = process.platform === 'win32';

/**
 * Execute a task via `claude -p`.
 * Returns { success, result, costUSD, durationMs, error }.
 */
export function executeTask(task, config) {
  const args = ['-p', task.prompt, '--output-format', 'json'];

  // Note: claude CLI has no --project-dir flag.
  // Use cwd option in execFileSync instead (see below).

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
    const execOpts = {
      encoding: 'utf-8',
      timeout: 30 * 60_000, // 30 minute timeout
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      shell: SHELL,
    };
    if (task.projectDir) {
      execOpts.cwd = task.projectDir;
    }
    const raw = execFileSync('claude', args, execOpts);

    const durationMs = Date.now() - startTime;
    let result;

    try {
      result = JSON.parse(raw);
    } catch {
      result = { rawOutput: raw.slice(0, 5000) };
    }

    const costUSD = result.cost_usd ?? result.costUSD ?? result.usage?.cost ?? null;

    // Save stdout to reports/<taskId>.json
    try {
      mkdirSync(REPORTS_DIR, { recursive: true });
      const reportPath = resolve(REPORTS_DIR, `${task.id}.json`);
      writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');
      logger.info(`Report saved to ${reportPath}`);
    } catch (e) {
      logger.warn(`Failed to save report: ${e.message}`);
    }

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

    // Save error output to reports/<taskId>-error.json
    try {
      mkdirSync(REPORTS_DIR, { recursive: true });
      const reportPath = resolve(REPORTS_DIR, `${task.id}-error.json`);
      writeFileSync(reportPath, JSON.stringify({ error: message.slice(0, 5000), stdout: stdout.slice(0, 5000) }, null, 2), 'utf-8');
      logger.info(`Error report saved to ${reportPath}`);
    } catch (e) { /* ignore */ }

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
