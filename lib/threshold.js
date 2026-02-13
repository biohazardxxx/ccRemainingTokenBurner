/**
 * Pure decision engine. Evaluates whether conditions allow running a task.
 * Returns { shouldRun, reason, availableBudget }.
 */
export function evaluate({ block, weeklyCost, config }) {
  const t = config.thresholds || {};
  const minRemaining = t.minRemainingMinutes ?? 60;
  const maxBlockCost = t.maxBlockCostUSD ?? 15.0;
  const weeklyBudget = t.weeklyBudgetUSD ?? 100.0;

  if (!block) {
    return { shouldRun: false, reason: 'No active billing block found', availableBudget: 0 };
  }

  if (block.remainingMinutes < minRemaining) {
    return {
      shouldRun: false,
      reason: `Block has ${block.remainingMinutes}min remaining (need >= ${minRemaining}min)`,
      availableBudget: 0,
    };
  }

  if (block.totalCost > maxBlockCost) {
    return {
      shouldRun: false,
      reason: `Block cost $${block.totalCost.toFixed(2)} exceeds max $${maxBlockCost.toFixed(2)} (block well-used)`,
      availableBudget: 0,
    };
  }

  if (weeklyCost >= weeklyBudget) {
    return {
      shouldRun: false,
      reason: `Weekly cost $${weeklyCost.toFixed(2)} >= budget $${weeklyBudget.toFixed(2)}`,
      availableBudget: 0,
    };
  }

  const fromWeekly = weeklyBudget - weeklyCost;
  const fromBlock = maxBlockCost - block.totalCost;
  const availableBudget = Math.round(Math.min(fromWeekly, fromBlock) * 100) / 100;

  return {
    shouldRun: true,
    reason: `Block underused ($${block.totalCost.toFixed(2)}/$${maxBlockCost.toFixed(2)}), ${block.remainingMinutes}min left, $${availableBudget.toFixed(2)} budget available`,
    availableBudget,
  };
}

/**
 * Check if current time is within quiet hours.
 * Returns true if execution should be suppressed.
 */
export function isQuietHours(quietStart, quietEnd) {
  if (quietStart == null || quietEnd == null) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const parseTime = (str) => {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  const start = parseTime(String(quietStart));
  const end = parseTime(String(quietEnd));

  // Handle overnight ranges (e.g., 23:00 - 07:00)
  if (start <= end) {
    return currentMinutes >= start && currentMinutes < end;
  }
  return currentMinutes >= start || currentMinutes < end;
}
