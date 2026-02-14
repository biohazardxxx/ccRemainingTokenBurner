import { loadCredentials, makeMinimalRequest, parseRateLimits, WINDOW_LABELS } from './get-rate-limits.mjs';
import * as logger from './logger.js';

export { WINDOW_LABELS };

/**
 * Fetch current rate limit status by making a minimal API call (~9 tokens)
 * using the Claude Code OAuth credentials.
 *
 * Returns null on failure, otherwise:
 * {
 *   windows: { "5h": { utilization, status, reset }, "7d": { ... }, ... },
 *   meta: { overallStatus, representativeClaim, fallbackPercentage, reset },
 *   subscription, tier, statusCode
 * }
 */
export async function fetchRateLimits() {
  try {
    const creds = loadCredentials();
    const response = await makeMinimalRequest(creds.accessToken);

    const rateLimits = parseRateLimits(response.headers);

    if (response.statusCode === 429) {
      rateLimits.meta.overallStatus = 'RATE LIMITED';
    } else if (response.statusCode !== 200) {
      logger.error(`API error ${response.statusCode}: ${response.body}`);
      return null;
    }

    return {
      ...rateLimits,
      subscription: creds.subscriptionType,
      tier: creds.rateLimitTier,
      statusCode: response.statusCode,
    };
  } catch (err) {
    logger.error(`Failed to fetch rate limits: ${err.message}`);
    return null;
  }
}
