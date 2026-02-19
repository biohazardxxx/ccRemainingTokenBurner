import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');
const CONTEXT_DIR = resolve(__dirname, '..', 'context');

const SHELL = process.platform === 'win32';

/**
 * Load context from the last run for a given task.
 * Returns a string to prepend to the prompt, or empty string.
 */
function loadLastRunContext(taskId) {
  const contextPath = resolve(CONTEXT_DIR, `${taskId}.md`);
  if (!existsSync(contextPath)) return '';

  try {
    const ctx = readFileSync(contextPath, 'utf-8').trim();
    if (!ctx) return '';
    logger.info(`Loaded context from previous run for "${taskId}"`);
    return `\n\n## Context from previous run\nThe following is a summary of what happened in the last run of this task. Use it to continue where you left off and avoid repeating work:\n\n${ctx}\n\n---\n\n`;
  } catch {
    return '';
  }
}

/**
 * Save context for the next run of a task.
 * Extracts a summary from the result to keep it concise.
 */
function saveRunContext(taskId, result, success, error) {
  try {
    mkdirSync(CONTEXT_DIR, { recursive: true });
    const contextPath = resolve(CONTEXT_DIR, `${taskId}.md`);

    let summary = '';
    const ts = new Date().toISOString();

    if (success) {
      const text = result?.result ?? result?.rawOutput ?? '';
      // Truncate to ~4000 chars to keep prompt size reasonable
      const truncated = typeof text === 'string' ? text.slice(0, 4000) : JSON.stringify(text).slice(0, 4000);
      summary = `**Last run:** ${ts} — ✅ SUCCESS\n\n${truncated}`;
    } else {
      summary = `**Last run:** ${ts} — ❌ FAILED\n**Error:** ${(error || 'unknown').slice(0, 1000)}`;
    }

    writeFileSync(contextPath, summary, 'utf-8');
    logger.info(`Context saved for next run of "${taskId}"`);
  } catch (e) {
    logger.warn(`Failed to save context: ${e.message}`);
  }
}

/**
 * Execute a task via `claude -p`.
 * Returns { success, result, costUSD, durationMs, error }.
 */
export function executeTask(task, config) {
  // Build prompt with optional context from last run
  const lastContext = loadLastRunContext(task.id);
  const fullPrompt = lastContext + task.prompt;

  const args = ['-p', fullPrompt, '--output-format', 'json'];

  // YOLO mode: skip all permission prompts
  const yolo = task.yolo ?? config.execution?.yolo ?? false;
  if (yolo) {
    args.push('--dangerously-skip-permissions');
    logger.info('YOLO mode enabled — skipping permission prompts');
  }

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

    // Save context for next run
    saveRunContext(task.id, result, true, null);

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

    // Save context for next run (even on failure)
    saveRunContext(task.id, { rawOutput: stdout }, false, message);

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
