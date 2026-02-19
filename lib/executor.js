import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '..', 'reports');
const CONTEXT_DIR = resolve(__dirname, '..', 'context');
const BASE_SETTINGS = resolve(__dirname, '..', '.claude', 'settings.local.json');

const SHELL = process.platform === 'win32';

/**
 * Base permissions every task gets (safe coding operations).
 */
const BASE_PERMISSIONS = [
  "Read(*)", "Write(*)", "Edit(*)",
  "Bash(find:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
  "Bash(grep:*)", "Bash(rg:*)", "Bash(wc:*)", "Bash(tree:*)", "Bash(stat:*)",
  "Bash(file:*)", "Bash(dirname:*)", "Bash(basename:*)", "Bash(realpath:*)",
  "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(chmod:*)",
  "Bash(git:*)",
  "Bash(python3:*)", "Bash(python:*)", "Bash(pip:*)", "Bash(pip3:*)", "Bash(pytest:*)",
  "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)",
  "Bash(sed:*)", "Bash(awk:*)", "Bash(sort:*)", "Bash(uniq:*)", "Bash(diff:*)",
  "Bash(echo:*)", "Bash(printf:*)", "Bash(date:*)", "Bash(which:*)", "Bash(pwd:*)",
  "Bash(cd:*)", "Bash(ccusage:*)", "Bash(claude:*)"
];

/**
 * Merge base permissions with task-specific extra permissions.
 * Writes a temporary .claude/settings.local.json in the task's projectDir.
 * Returns a cleanup function to restore the original.
 */
function setupTaskPermissions(task) {
  const cwd = task.projectDir || process.cwd();
  const settingsDir = resolve(cwd, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.local.json');

  // Read existing settings (if any) for restoration
  let originalContent = null;
  let hadFile = false;
  if (existsSync(settingsPath)) {
    hadFile = true;
    originalContent = readFileSync(settingsPath, 'utf-8');
  }

  // Merge permissions: base + task-specific extras
  const extraPerms = task.permissions || [];
  const allPerms = [...new Set([...BASE_PERMISSIONS, ...extraPerms])];

  const settings = { permissions: { allow: allPerms } };

  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    if (extraPerms.length > 0) {
      logger.info(`Task permissions: base + ${extraPerms.length} extra (${extraPerms.slice(0, 3).join(', ')}${extraPerms.length > 3 ? '...' : ''})`);
    }
  } catch (e) {
    logger.warn(`Failed to write task permissions: ${e.message}`);
  }

  // Return cleanup function
  return () => {
    try {
      if (hadFile && originalContent !== null) {
        writeFileSync(settingsPath, originalContent, 'utf-8');
      } else if (!hadFile) {
        // Don't remove — leave base permissions for future runs
      }
    } catch { /* ignore */ }
  };
}

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
  // Setup task-specific permissions (merged with base)
  const cleanupPermissions = setupTaskPermissions(task);

  // Build prompt with optional context from last run
  const lastContext = loadLastRunContext(task.id);
  const fullPrompt = lastContext + task.prompt;

  const args = ['-p', fullPrompt, '--output-format', 'json'];

  // YOLO mode: skip all permission prompts (doesn't work as root)
  const yolo = task.yolo ?? config.execution?.yolo ?? false;
  if (yolo) {
    args.push('--dangerously-skip-permissions');
    logger.info('YOLO mode enabled — skipping permission prompts');
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
    const execOpts = {
      encoding: 'utf-8',
      timeout: 30 * 60_000,
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
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

    saveRunContext(task.id, result, true, null);
    cleanupPermissions();
    logger.success(`Task completed in ${(durationMs / 1000).toFixed(1)}s`);

    return { success: true, result, costUSD, durationMs, error: null };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    const message = stderr || err.message;

    try {
      mkdirSync(REPORTS_DIR, { recursive: true });
      const reportPath = resolve(REPORTS_DIR, `${task.id}-error.json`);
      writeFileSync(reportPath, JSON.stringify({ error: message.slice(0, 5000), stdout: stdout.slice(0, 5000) }, null, 2), 'utf-8');
      logger.info(`Error report saved to ${reportPath}`);
    } catch (e) { /* ignore */ }

    saveRunContext(task.id, { rawOutput: stdout }, false, message);
    cleanupPermissions();
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
