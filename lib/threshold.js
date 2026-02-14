/**
 * Pure decision engine. Evaluates whether conditions allow running a task
 * based on rate limit utilization data from the API.
 *
 * Returns { shouldRun, reason, bindingWindow, utilization }.
 */
export function evaluate({ rateLimits, config }) {
  const t = config.thresholds || {};
  const maxUtil = t.maxUtilization ?? 0.80;

  if (!rateLimits) {
    return { shouldRun: false, reason: 'Failed to fetch rate limits', bindingWindow: null, utilization: null };
  }

  // Rate limited (429)
  if (rateLimits.statusCode === 429) {
    return { shouldRun: false, reason: 'Currently rate limited (429)', bindingWindow: null, utilization: null };
  }

  const windows = rateLimits.windows;
  if (!windows || Object.keys(windows).length === 0) {
    return { shouldRun: false, reason: 'No rate limit windows found in response', bindingWindow: null, utilization: null };
  }

  // Check if any window is explicitly blocked
  for (const [name, data] of Object.entries(windows)) {
    if (data.status && data.status !== 'allowed') {
      const pct = data.utilization != null ? ` (${(data.utilization * 100).toFixed(1)}% used)` : '';
      return {
        shouldRun: false,
        reason: `Window "${name}" is ${data.status}${pct}`,
        bindingWindow: name,
        utilization: data.utilization,
      };
    }
  }

  // Determine binding window: use representativeClaim from API, or fall back to highest utilization
  const bindingName = rateLimits.meta.representativeClaim;
  let activeWindow, activeWindowName;

  if (bindingName && windows[bindingName]) {
    activeWindow = windows[bindingName];
    activeWindowName = bindingName;
  } else {
    // Fall back to window with highest utilization
    const sorted = Object.entries(windows).sort(([, a], [, b]) => (b.utilization ?? 0) - (a.utilization ?? 0));
    if (sorted.length > 0) {
      [activeWindowName, activeWindow] = sorted[0];
    }
  }

  if (!activeWindow) {
    return { shouldRun: false, reason: 'No usable rate limit window found', bindingWindow: null, utilization: null };
  }

  const util = activeWindow.utilization ?? 0;

  // Check utilization threshold
  if (util >= maxUtil) {
    const pctUsed = (util * 100).toFixed(1);
    const threshold = (maxUtil * 100).toFixed(1);
    return {
      shouldRun: false,
      reason: `Window "${activeWindowName}" at ${pctUsed}% utilization (>= ${threshold}% threshold, well-used)`,
      bindingWindow: activeWindowName,
      utilization: util,
    };
  }

  // All checks passed — capacity available
  const pctUsed = (util * 100).toFixed(1);
  const pctRemaining = ((1 - util) * 100).toFixed(1);
  let resetInfo = '';
  if (activeWindow.reset) {
    const resetMs = activeWindow.reset * 1000 - Date.now();
    if (resetMs > 0) {
      resetInfo = `, resets ${formatDuration(resetMs)}`;
    }
  }

  return {
    shouldRun: true,
    reason: `Window "${activeWindowName}" at ${pctUsed}% (${pctRemaining}% remaining${resetInfo})`,
    bindingWindow: activeWindowName,
    utilization: util,
  };
}

function formatDuration(ms) {
  if (ms <= 0) return 'now';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `in ${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `in ${d}d ${remH}h`;
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
