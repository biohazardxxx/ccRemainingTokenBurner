# ccRemainingTokenBurner

Automatically run queued Claude Code tasks when your rate limit capacity is underused. No tokens left on the table.

Claude Code subscriptions have rolling rate limit windows (5-hour and 7-day). Unused capacity within a window is wasted. This tool queries your current utilization directly from the Anthropic API and automatically runs queued tasks (via `claude -p`) when there's spare capacity.

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** - authenticated and available as `claude`

Rate limits are fetched directly from the Anthropic API using your Claude Code OAuth credentials (`~/.claude/.credentials.json`). No additional tools required.

## Quick Start

```bash
# Clone / download
cd ccRemainingTokenBurner

# Check current status
node bin/burn.js --status

# Preview what would happen
node bin/burn.js --dry-run

# Run one cycle
node bin/burn.js

# Run continuously
node bin/burn.js --watch
```

Or install globally:

```bash
npm install -g .
burn --status
```

## CLI Reference

```
burn [options]

Modes:
  --once              Run one check cycle then exit (default)
  --watch, -w         Run in watch mode (check every N minutes)
  --status, -s        Show current rate limit status + task queue dashboard
  --dry-run, -d       Show what would happen without executing

Options:
  --config <path>     Path to config.json (default: ./config.json)
  --tasks <path>      Path to tasks.json (default: ./tasks.json)
  --verbose, -v       Detailed output
  --help, -h          Show this help
```

## Configuration

Edit `config.json` to control thresholds and behavior. All fields are optional — sensible defaults are used if the file is missing.

```json
{
  "thresholds": {
    "maxUtilization": 0.80
  },
  "watch": {
    "intervalMinutes": 10,
    "quietHoursStart": null,
    "quietHoursEnd": null
  },
  "execution": {
    "model": null,
    "defaultAllowedTools": null
  }
}
```

### Thresholds

| Field | Default | Description |
|-------|---------|-------------|
| `maxUtilization` | `0.80` | Only run tasks if the binding window utilization is **below** this (0.0–1.0). At 0.80, tasks run while less than 80% of your quota is used. |

### Watch

| Field | Default | Description |
|-------|---------|-------------|
| `intervalMinutes` | `10` | How often to check in watch mode |
| `quietHoursStart` | `null` | Suppress execution after this time (e.g. `"22:00"`) |
| `quietHoursEnd` | `null` | Resume execution after this time (e.g. `"07:00"`) |

Overnight ranges work correctly — `"23:00"` to `"07:00"` suppresses from 11 PM to 7 AM.

### Execution

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `null` | Default Claude model for all tasks (overridable per-task) |
| `defaultAllowedTools` | `null` | Default allowed tools (overridable per-task) |
| `yolo` | `false` | Enable YOLO mode globally (`--dangerously-skip-permissions`). Skips all permission prompts. Can also be set per-task. |

## Task Queue

Define tasks in `tasks.json`:

```json
{
  "tasks": [
    {
      "id": "refactor-utils",
      "name": "Refactor utility functions",
      "prompt": "Review and refactor all utility functions in src/utils for clarity.",
      "projectDir": "E:\\Coding\\my-project",
      "status": "on",
      "priority": 1,
      "model": null,
      "allowedTools": null,
      "maxBudgetUSD": 2.00,
      "repeat": false
    }
  ]
}
```

### Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Human-readable name shown in logs |
| `prompt` | Yes | The prompt sent to `claude -p` |
| `projectDir` | No | Working directory for Claude (`--project-dir`) |
| `status` | Yes | `"on"`, `"off"`, `"done"`, `"running"`, `"failed"` |
| `priority` | No | Lower = higher priority (default: 999) |
| `model` | No | Override model for this task |
| `allowedTools` | No | Override allowed tools for this task |
| `maxBudgetUSD` | No | Per-task cost cap (`--max-budget-usd`) |
| `repeat` | No | If `true`, resets to `"on"` after completion |
| `yolo` | No | Enable YOLO mode for this task (overrides config default) |

### Status Lifecycle

```
off ──[user enables]──> on ──[picked]──> running ──┬──[success, repeat=false]──> done
                         ^                          ├──[success, repeat=true ]──> on
                         │                          └──[failure]───────────────> failed
                         └──────────[user resets]──────────────────────────────────┘
```

## Decision Flow

Each cycle evaluates these conditions in order:

1. **Fetch rate limits** — Makes a minimal API call (~9 tokens) to read `anthropic-ratelimit-unified-*` response headers.
2. **Rate limited?** — If the API returns 429, skip.
3. **Any window blocked?** — If any rate limit window has status other than `"allowed"`, skip.
4. **Utilization check** — Find the binding window (the bottleneck window reported by the API). If its utilization >= `maxUtilization`, the quota is well-used → skip.
5. **Pick task** — Highest-priority task with `"status": "on"`.
6. **Execute** — `claude -p "<prompt>" --output-format json [options]`
7. **Update** — Set task status, append to `history.json`.

## Rate Limit Windows

The API reports utilization across multiple rolling windows:

| Window | Description |
|--------|-------------|
| `5h` | 5-hour rolling window |
| `7d` | 7-day rolling window |
| `7d_sonnet` | 7-day Sonnet-specific window |
| `overage` | Overage allowance |

The **binding window** (`representativeClaim`) is the window currently closest to its limit — the one that would rate-limit you first. The decision engine uses this window for its utilization check.

You can also query rate limits standalone:

```bash
node lib/get-rate-limits.mjs          # human-readable output
node lib/get-rate-limits.mjs --json   # JSON for scripting
node lib/get-rate-limits.mjs --debug  # show raw headers
```

## Watch Mode

```bash
burn --watch
```

- Checks every `intervalMinutes` (default: 10)
- Respects quiet hours — skips cycles during the configured window
- Sleeps in 5-second increments for responsive Ctrl+C on Windows
- Graceful shutdown on SIGINT/SIGTERM

## Status Dashboard

```bash
burn --status
```

Shows at a glance:
- All rate limit windows with utilization bars, status, and reset times
- Subscription type and tier
- Binding window identification
- Threshold evaluation result with reason
- Full task queue table
- Last 10 execution history entries

## Run Context (Continuity Between Runs)

When a task completes (success or failure), the executor saves a context summary to `context/<taskId>.md`. On the next run of the same task, this context is automatically prepended to the prompt, giving Claude awareness of what happened last time.

This is useful for:
- **Repeating tasks** that build on previous work
- **Failed tasks** that need to retry — Claude knows what went wrong
- **Multi-session work** where a task is too large for a single run

Context files are kept concise (~4000 chars max) and are gitignored (local state only).

## systemd Service

For production use, install as a systemd service so the watch mode survives reboots and shell disconnects:

```bash
sudo ./install-service.sh           # Install & start
sudo ./install-service.sh --uninstall  # Remove
systemctl status token-burner       # Check status
journalctl -u token-burner -f       # Follow logs
```

## Project Structure

```
bin/
  burn.js              CLI entry point
lib/
  get-rate-limits.mjs  Query Anthropic API for rate limit headers
  rate-limits.js       Rate limit fetcher (wraps get-rate-limits.mjs)
  threshold.js         Decision engine (pure, no side effects)
  task-manager.js      Load, pick, update tasks.json
  executor.js          Spawn claude -p processes + context management
  scheduler.js         Watch mode loop
  history.js           Execution log management
  logger.js            Formatted console output
install-service.sh     systemd service installer
config.json            User configuration
tasks.json             Task queue
history.json           Auto-generated execution log
context/               Run context for task continuity (gitignored)
reports/               Task output reports (gitignored)
```

Zero npm dependencies. Pure Node.js built-in modules only.

## License

MIT
