#!/usr/bin/env node
/**
 * get-rate-limits.mjs
 *
 * Queries your Claude subscription rate limit status by making a minimal
 * API call with your Claude Code OAuth credentials and reading the
 * `anthropic-ratelimit-unified-*` response headers.
 *
 * Usage:
 *   node get-rate-limits.mjs          # human-readable output
 *   node get-rate-limits.mjs --json   # JSON output for programmatic use
 *   node get-rate-limits.mjs --debug  # show raw headers
 *
 * Each call costs ~9 tokens from your quota (a 1-token Sonnet completion).
 * Negligible, but don't run it in a tight loop.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import https from "https";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const API_HOST = "api.anthropic.com";
const API_PATH = "/v1/messages";
// See https://docs.anthropic.com/en/api/versioning for the latest version
const ANTHROPIC_VERSION = "2023-06-01";

export function loadCredentials() {
  const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error("No OAuth access token found in credentials");
  }
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    console.error(
      "WARNING: OAuth token may be expired. Run `claude` to refresh it."
    );
  }
  return oauth;
}

export function makeMinimalRequest(accessToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    });

    const options = {
      hostname: API_HOST,
      port: 443,
      path: API_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": "oauth-2025-04-20",
        Authorization: `Bearer ${accessToken}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export function parseRateLimits(headers) {
  const PREFIX = "anthropic-ratelimit-unified-";
  const raw = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(PREFIX)) {
      raw[key.slice(PREFIX.length)] = value;
    }
  }

  // Parse into structured windows
  // Keys look like: status, 5h-status, 5h-reset, 5h-utilization,
  // 7d-status, 7d-reset, 7d-utilization, representative-claim, etc.
  const windows = {};
  const meta = {};

  for (const [key, value] of Object.entries(raw)) {
    // Meta keys (no window prefix)
    if (key === "status") {
      meta.overallStatus = value;
      continue;
    }
    if (key === "representative-claim") {
      meta.representativeClaim = value;
      continue;
    }
    if (key === "fallback-percentage") {
      meta.fallbackPercentage = parseFloat(value);
      continue;
    }
    if (key === "reset") {
      meta.reset = parseInt(value);
      continue;
    }

    // Window keys: {window}-{metric}
    const lastDash = key.lastIndexOf("-");
    if (lastDash === -1) continue;
    const metric = key.slice(lastDash + 1);
    const window = key.slice(0, lastDash);

    if (!windows[window]) windows[window] = {};
    if (metric === "utilization") {
      windows[window].utilization = parseFloat(value);
    } else if (metric === "reset") {
      windows[window].reset = parseInt(value);
    } else if (metric === "status") {
      windows[window].status = value;
    }
  }

  return { windows, meta, raw };
}

export const WINDOW_LABELS = {
  "5h": "5-hour window",
  "7d": "7-day window",
  "7d_sonnet": "7-day Sonnet",
  overage: "Overage",
};

function formatOutput(rateLimits, creds) {
  const { windows, meta } = rateLimits;
  const lines = [];

  lines.push("=== Claude Rate Limit Status ===");
  lines.push(`Subscription: ${creds.subscriptionType}`);
  lines.push(`Tier: ${creds.rateLimitTier}`);
  lines.push(`Overall: ${meta.overallStatus}`);
  if (meta.representativeClaim) {
    lines.push(`Binding window: ${meta.representativeClaim}`);
  }
  lines.push("");

  for (const [name, data] of Object.entries(windows)) {
    const label = WINDOW_LABELS[name] || name;
    const pctUsed = (data.utilization * 100).toFixed(1);
    const pctFree = ((1 - data.utilization) * 100).toFixed(1);
    const bar = makeBar(data.utilization);

    let resetStr = "";
    if (data.reset) {
      const resetDate = new Date(data.reset * 1000);
      const diffMs = resetDate - Date.now();
      resetStr = ` | resets ${formatDuration(diffMs)}`;
    }

    const statusIcon = data.status === "allowed" ? "OK" : "BLOCKED";
    lines.push(`${label} [${statusIcon}]`);
    lines.push(`  ${bar} ${pctUsed}% used (${pctFree}% remaining)${resetStr}`);
    lines.push("");
  }

  return lines.join("\n");
}

function makeBar(utilization, width = 30) {
  const filled = Math.round(utilization * width);
  const empty = width - filled;
  return "[" + "#".repeat(filled) + "-".repeat(empty) + "]";
}

function formatDuration(ms) {
  if (ms <= 0) return "now";
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `in ${h}h ${m}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `in ${d}d ${remH}h`;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const debugMode = args.includes("--debug");

  try {
    const creds = loadCredentials();
    const response = await makeMinimalRequest(creds.accessToken);

    if (debugMode) {
      console.log("Status:", response.statusCode);
      console.log("Headers:", JSON.stringify(response.headers, null, 2));
    }

    // Both 200 and 429 responses include rate limit headers
    const rateLimits = parseRateLimits(response.headers);

    if (response.statusCode === 429) {
      rateLimits.meta.overallStatus = "RATE LIMITED";
    } else if (response.statusCode !== 200) {
      console.error(`API error ${response.statusCode}: ${response.body}`);
      process.exit(1);
    }

    if (jsonMode) {
      const output = {
        status: response.statusCode === 429 ? "rate_limited" : "ok",
        subscription: creds.subscriptionType,
        tier: creds.rateLimitTier,
        overallStatus: rateLimits.meta.overallStatus,
        bindingWindow: rateLimits.meta.representativeClaim,
        windows: {},
      };
      for (const [name, data] of Object.entries(rateLimits.windows)) {
        output.windows[name] = {
          status: data.status,
          utilization: data.utilization,
          remainingPct: +(((1 - data.utilization) * 100).toFixed(1)),
          resetAt: data.reset ? new Date(data.reset * 1000).toISOString() : null,
          resetInMinutes: data.reset
            ? Math.max(0, Math.ceil((data.reset * 1000 - Date.now()) / 60000))
            : null,
        };
      }
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(formatOutput(rateLimits, creds));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

// Only run main() when invoked directly as a script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
