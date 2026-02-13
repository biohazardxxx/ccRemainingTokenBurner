#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveBlock } from '../lib/block-status.js';
import { getWeeklyCost } from '../lib/weekly-tracker.js';
import { evaluate, isQuietHours } from '../lib/threshold.js';
import { loadTasks, saveTasks, pickTask, updateTaskStatus, getTaskSummary } from '../lib/task-manager.js';
import { executeTask } from '../lib/executor.js';
import { appendRecord, getRecentHistory } from '../lib/history.js';
import { watchLoop } from '../lib/scheduler.js';
import * as logger from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// --- CLI Argument Parsing ---

function parseArgs(argv) {
  const args = {
    watch: false,
    dryRun: false,
    status: false,
    once: false,
    verbose: false,
    help: false,
    configPath: resolve(PROJECT_ROOT, 'config.json'),
    tasksPath: resolve(PROJECT_ROOT, 'tasks.json'),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--watch': case '-w': args.watch = true; break;
      case '--dry-run': case '-d': args.dryRun = true; break;
      case '--status': case '-s': args.status = true; break;
      case '--once': args.once = true; break;
      case '--verbose': case '-v': args.verbose = true; break;
      case '--help': case '-h': args.help = true; break;
      case '--config':
        args.configPath = resolve(argv[++i] || 'config.json');
        break;
      case '--tasks':
        args.tasksPath = resolve(argv[++i] || 'tasks.json');
        break;
      default:
        logger.warn(`Unknown argument: ${arg}`);
    }
  }

  // Default to --once if no mode specified
  if (!args.watch && !args.status && !args.help) {
    args.once = true;
  }

  return args;
}

function showHelp() {
  console.log(`
burn - Automatically run Claude Code tasks when billing block capacity is underused

Usage: burn [options]

Modes:
  --once              Run one check cycle then exit (default)
  --watch, -w         Run in watch mode (check every N minutes)
  --status, -s        Show current block status + task queue dashboard
  --dry-run, -d       Show what would happen without executing

Options:
  --config <path>     Path to config.json (default: ./config.json)
  --tasks <path>      Path to tasks.json (default: ./tasks.json)
  --verbose, -v       Detailed output
  --help, -h          Show this help

Examples:
  burn                     Check once and run a task if conditions met
  burn --watch             Continuously monitor and run tasks
  burn --dry-run           Preview without executing
  burn --status            Dashboard view of block + tasks
`.trim());
}

// --- Config Loading ---

function loadConfig(configPath) {
  const defaults = {
    thresholds: {
      minRemainingMinutes: 60,
      maxBlockCostUSD: 15.0,
      weeklyBudgetUSD: 100.0,
      weeklyStartDay: 'monday',
    },
    watch: {
      intervalMinutes: 10,
      quietHoursStart: null,
      quietHoursEnd: null,
    },
    execution: {
      model: null,
      defaultAllowedTools: null,
    },
  };

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const user = JSON.parse(raw);
    // Deep merge one level
    return {
      thresholds: { ...defaults.thresholds, ...user.thresholds },
      watch: { ...defaults.watch, ...user.watch },
      execution: { ...defaults.execution, ...user.execution },
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.debug(`No config at ${configPath}, using defaults`);
    } else {
      logger.warn(`Failed to read config: ${err.message}, using defaults`);
    }
    return defaults;
  }
}

// --- Status Dashboard ---

function showStatus(config, tasksPath) {
  const historyPath = resolve(dirname(tasksPath), 'history.json');

  logger.header('Block Status');
  const block = getActiveBlock();
  if (block) {
    console.log(`  Start:     ${block.start.toLocaleString()}`);
    console.log(`  End:       ${block.end.toLocaleString()}`);
    console.log(`  Remaining: ${block.remainingMinutes} minutes`);
    console.log(`  Cost:      $${block.totalCost.toFixed(2)}`);
  } else {
    console.log('  No active block');
  }

  logger.header('Weekly Cost');
  const weeklyCost = getWeeklyCost(config.thresholds.weeklyStartDay);
  const weeklyBudget = config.thresholds.weeklyBudgetUSD;
  console.log(`  This week: $${weeklyCost.toFixed(2)} / $${weeklyBudget.toFixed(2)}`);

  logger.header('Threshold Evaluation');
  const decision = evaluate({ block, weeklyCost, config });
  console.log(`  Should run: ${decision.shouldRun ? 'YES' : 'NO'}`);
  console.log(`  Reason:     ${decision.reason}`);
  if (decision.availableBudget > 0) {
    console.log(`  Budget:     $${decision.availableBudget.toFixed(2)}`);
  }

  logger.header('Task Queue');
  const taskData = loadTasks(tasksPath);
  const summary = getTaskSummary(taskData);
  if (summary.length > 0) {
    logger.table(summary);
  } else {
    console.log('  No tasks defined');
  }

  logger.header('Recent History');
  const recent = getRecentHistory(historyPath);
  if (recent.length > 0) {
    logger.table(recent);
  } else {
    console.log('  No execution history');
  }
}

// --- Core Cycle ---

function runCycle(config, tasksPath, dryRun) {
  const historyPath = resolve(dirname(tasksPath), 'history.json');

  // 1. Fetch active block
  logger.info('Checking block status...');
  const block = getActiveBlock();

  // 2. Fetch weekly cost
  const weeklyCost = getWeeklyCost(config.thresholds.weeklyStartDay);

  // 3. Evaluate thresholds
  const decision = evaluate({ block, weeklyCost, config });
  logger.info(`Decision: ${decision.reason}`);

  if (!decision.shouldRun) {
    return;
  }

  // 4. Pick a task
  const taskData = loadTasks(tasksPath);
  const task = pickTask(taskData, decision.availableBudget);

  if (!task) {
    logger.info('No eligible tasks in queue');
    return;
  }

  logger.info(`Selected task: "${task.name}" (priority ${task.priority ?? '-'}, budget $${task.maxBudgetUSD ?? 'unlimited'})`);

  if (dryRun) {
    logger.warn('[DRY RUN] Would execute this task. Stopping here.');
    return;
  }

  // 5. Mark as running
  updateTaskStatus(taskData, task.id, 'running');
  saveTasks(tasksPath, taskData);

  // 6. Execute
  const result = executeTask(task, config);

  // 7. Update status
  let newStatus;
  if (result.success) {
    newStatus = task.repeat ? 'on' : 'done';
  } else {
    newStatus = 'failed';
  }
  updateTaskStatus(taskData, task.id, newStatus);
  saveTasks(tasksPath, taskData);

  // 8. Log to history
  appendRecord(historyPath, {
    taskId: task.id,
    taskName: task.name,
    success: result.success,
    costUSD: result.costUSD,
    durationMs: result.durationMs,
    error: result.error,
  });

  if (result.success) {
    logger.success(`Task "${task.name}" completed -> ${newStatus}`);
  } else {
    logger.error(`Task "${task.name}" failed: ${result.error?.slice(0, 200)}`);
  }
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  logger.setVerbose(args.verbose);

  const config = loadConfig(args.configPath);

  if (args.status) {
    showStatus(config, args.tasksPath);
    process.exit(0);
  }

  if (args.watch) {
    await watchLoop(
      () => runCycle(config, args.tasksPath, args.dryRun),
      config,
    );
  } else {
    // --once (default)
    runCycle(config, args.tasksPath, args.dryRun);
  }
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
