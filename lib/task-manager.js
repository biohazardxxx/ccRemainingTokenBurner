import { readFileSync, writeFileSync } from 'node:fs';
import * as logger from './logger.js';

/**
 * Load tasks from the given path.
 * Returns { tasks: [] } on error or missing file.
 */
export function loadTasks(tasksPath) {
  try {
    const raw = readFileSync(tasksPath, 'utf-8');
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn(`Tasks file not found: ${tasksPath}`);
    } else {
      logger.error(`Failed to load tasks: ${err.message}`);
    }
    return { tasks: [] };
  }
}

/**
 * Save tasks back to disk.
 */
export function saveTasks(tasksPath, data) {
  writeFileSync(tasksPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Pick the highest-priority task with status "on" that fits within the budget.
 * Returns null if no suitable task is found.
 */
export function pickTask(data, availableBudget) {
  const candidates = (data.tasks || [])
    .filter(t => t.status === 'on')
    .filter(t => {
      if (t.maxBudgetUSD && t.maxBudgetUSD > availableBudget) {
        logger.debug(`Skipping "${t.name}": budget $${t.maxBudgetUSD} > available $${availableBudget}`);
        return false;
      }
      return true;
    })
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  return candidates[0] || null;
}

/**
 * Update a task's status in the data object.
 */
export function updateTaskStatus(data, taskId, status) {
  const task = (data.tasks || []).find(t => t.id === taskId);
  if (task) {
    task.status = status;
  }
}

/**
 * Get summary of all tasks for display.
 */
export function getTaskSummary(data) {
  return (data.tasks || []).map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    priority: t.priority ?? '-',
    budget: t.maxBudgetUSD ? `$${t.maxBudgetUSD.toFixed(2)}` : '-',
    repeat: t.repeat ? 'yes' : 'no',
  }));
}
