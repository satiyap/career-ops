#!/bin/bash
# Daily zero-token portal scan for career-ops. Run by the launchd agent
# com.career-ops.daily-scan (8:00 AM IST). Uses the local tuned portals.yml +
# parsers; appends a timestamped summary to logs/daily-scan.log.
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/opt/homebrew/bin/node"
LOG="$PROJECT_DIR/logs/daily-scan.log"

# launchd runs with a minimal PATH. scan.mjs spawns the local parsers via the
# `node` command (portals.yml parser.command), so node's dir MUST be on PATH for
# the child processes to resolve it — otherwise the Workday/Rippling/LinkedIn
# parsers fail with "spawn node ENOENT".
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$PROJECT_DIR" || exit 1
mkdir -p logs

{
  echo ""
  echo "========================================================"
  echo "=== career-ops daily scan — $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  echo "========================================================"
  # grep -c always prints a count (0 on no match), so no `|| echo` fallback.
  before=$(grep -cE '^[[:space:]]*-[[:space:]]*\[ \]' data/pipeline.md 2>/dev/null)
  before=${before:-0}
  "$NODE" scan.mjs 2>&1
  after=$(grep -cE '^[[:space:]]*-[[:space:]]*\[ \]' data/pipeline.md 2>/dev/null)
  after=${after:-0}
  echo "--- pending in inbox: ${before} -> ${after} (net $(( after - before ))) ---"
  echo "=== done $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
} >> "$LOG" 2>&1
