# ccRemainingTokenBurner

Automatically run queued Claude Code tasks when your billing block capacity is underused. No tokens left on the table.

Claude Code subscriptions have 5-hour billing blocks and weekly limits. Tokens unused within a block are wasted. This tool monitors block usage via [`ccusage`](https://github.com/ryoppippi/ccusage) and automatically runs queued tasks (via `claude -p`) when there's spare capacity.

## Prerequisites

- **Node.js** >= 18
- **ccusage** - `npm i -g ccusage`
- **Claude Code CLI** - authenticated and available as `claude`

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
  --status, -s        Show current block status + task queue dashboard
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
    "minRemainingMinutes": 60,
    "maxBlockCostUSD": 15.00,
    "weeklyBudgetUSD": 100.00,
    "weeklyStartDay": "monday"
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
| `minRemainingMinutes` | `60` | Only run tasks if the block has at least this many minutes left |
| `maxBlockCostUSD` | `15.00` | Only run if block cost is **below** this (block is underused) |
| `weeklyBudgetUSD` | `100.00` | Weekly spending cap across all blocks |
| `weeklyStartDay` | `"monday"` | Which day resets the weekly budget counter |

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

### Status Lifecycle

```
off ──[user enables]──> on ──[picked]──> running ──┬──[success, repeat=false]──> done
                         ^                          ├──[success, repeat=true ]──> on
                         │                          └──[failure]───────────────> failed
                         └──────────[user resets]──────────────────────────────────┘
```

## Decision Flow

Each cycle evaluates these conditions in order:

1. **Active block?** — Fetch via `ccusage blocks --active --json`. No block → skip.
2. **Enough time?** — `remainingMinutes >= minRemainingMinutes`. Too little → skip.
3. **Block underused?** — `totalCost <= maxBlockCostUSD`. Already well-used → skip.
4. **Weekly budget?** — `weeklyCost < weeklyBudgetUSD`. Over budget → skip.
5. **Calculate budget** — `min(weeklyBudget - weeklyCost, maxBlockCost - blockCost)`
6. **Pick task** — Highest-priority task with `"status": "on"` that fits within budget.
7. **Execute** — `claude -p "<prompt>" --output-format json [options]`
8. **Update** — Set task status, append to `history.json`.

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
- Current block (start, end, remaining time, cost)
- Weekly cost vs. budget
- Threshold evaluation result with reason
- Full task queue table
- Last 10 execution history entries

## Project Structure

```
bin/
  burn.js              CLI entry point
lib/
  block-status.js      Fetch & parse ccusage block data
  weekly-tracker.js    Weekly cost aggregation
  threshold.js         Decision engine (pure, no side effects)
  task-manager.js      Load, pick, update tasks.json
  executor.js          Spawn claude -p processes
  scheduler.js         Watch mode loop
  history.js           Execution log management
  logger.js            Formatted console output
config.json            User configuration
tasks.json             Task queue
history.json           Auto-generated execution log
```

Zero npm dependencies. Pure Node.js built-in modules only.

## License

MIT
