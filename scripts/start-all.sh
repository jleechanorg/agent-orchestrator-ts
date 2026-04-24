#!/bin/bash
# Start AO for all projects defined in agent-orchestrator.yaml.
# First project: ao start (dashboard + lifecycle-worker + orchestrator) when AO_START_DASHBOARD=1
# All selected projects: direct lifecycle-worker startup when AO_START_DASHBOARD!=1
#
# Idempotent: skips lifecycle-workers that are already running per project.
# Pre-flight: validates YAML parses cleanly before attempting to start anything.
set -euo pipefail

# Prepend .local/bin so gh and other user-local tools are found
# when launchd inherits the launch-agent PATH.
export PATH="/Users/jleechan/.local/bin:$PATH"

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/ao-config-topology.sh
source "$SCRIPT_DIR/lib/ao-config-topology.sh"

# Resolve the ao CLI binary. Prefer the source tree (has all fork subcommands)
# when running from a repo checkout; fall back to PATH-resolved ao (global npm).
_ao_bin() {
  if [ -f "$REPO_ROOT/packages/cli/dist/index.js" ]; then
    echo "$REPO_ROOT/packages/cli/dist/index.js"
  else
    command -v ao 2>/dev/null || echo "ao"
  fi
}
AO_CLI="$(_ao_bin)"
export AO_CLI_PATH="$AO_CLI"

# Prevent overlapping lifecycle-all runs (launchd/manual retries can race).
LOCKDIR="${AO_START_ALL_LOCKDIR:-/tmp/ao-start-all.lock}"
LOCK_ACQUIRED=false
cleanup_lock() { if $LOCK_ACQUIRED; then rmdir "$LOCKDIR" 2>/dev/null || true; fi; }
trap cleanup_lock EXIT
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # Reap stale lock (e.g., crashed/terminated start-all run).
  if [ -d "$LOCKDIR" ]; then
    lock_mtime="$(stat -f %m "$LOCKDIR" 2>/dev/null || stat -c %Y "$LOCKDIR" 2>/dev/null || echo "0")"
    lock_age=$(( $(date +%s) - lock_mtime ))
    if [ "$lock_age" -gt 600 ]; then
      rmdir "$LOCKDIR" 2>/dev/null || true
      if ! mkdir "$LOCKDIR" 2>/dev/null; then
        echo "SKIP: start-all already running (lock contested: $LOCKDIR)"
        exit 0
      fi
    else
      echo "SKIP: start-all already running (lock: $LOCKDIR)"
      exit 0
    fi
  else
    echo "SKIP: start-all already running (lock: $LOCKDIR)"
    exit 0
  fi
fi
LOCK_ACQUIRED=true

# bd-8gld: Guard main repo branch invariant before doing anything.
# AO agents work in git worktrees — the main clone must stay on main.
MAIN_REPO="${AO_MAIN_REPO:-$HOME/project_agento/agent-orchestrator}"
if [ -e "$MAIN_REPO/.git" ]; then
  CURRENT_BRANCH="$(git -C "$MAIN_REPO" branch --show-current 2>/dev/null || true)"
  if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "WARNING: main repo is on branch '$CURRENT_BRANCH' — switching to main"
    if ! git -C "$MAIN_REPO" checkout main; then
      echo "ERROR: failed to checkout main — resolve manually (uncommitted changes? conflicts?)"
      echo "  Fix: cd \"$MAIN_REPO\" && git status"
      exit 1
    elif ! git -C "$MAIN_REPO" pull --ff-only; then
      echo "WARNING: git pull --ff-only failed — continuing anyway"
    fi
  fi
fi

if [ -z "${AO_CONFIG_PATH:-}" ]; then
  ao_validate_topology
fi

CONFIG_FILE="${AO_CONFIG_PATH:-$(ao_find_config_path 2>/dev/null || ao_staging_config_path)}"
export AO_CONFIG_PATH="$CONFIG_FILE"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config not found at $CONFIG_FILE"
  exit 1
fi

# Pre-flight: validate YAML parses without errors (catches duplicate keys, syntax errors)
if ! python3 -c "import yaml; yaml.safe_load(open('$CONFIG_FILE'))" 2>/dev/null; then
  echo "ERROR: $CONFIG_FILE has YAML parse errors. Run scripts/validate-config.sh for details."
  exit 1
fi
echo "Config OK: $CONFIG_FILE"

PROJECTS=$(python3 -c "
import yaml
with open('$CONFIG_FILE') as f:
    cfg = yaml.safe_load(f)
for pid in cfg.get('projects', {}):
    print(pid)
" 2>/dev/null)

if [ -z "$PROJECTS" ]; then
  echo "ERROR: No projects found in $CONFIG_FILE"
  exit 1
fi

SELECTED="${@:-$PROJECTS}"
LOG_DIR="${AO_LOG_DIR:-${HOME}/.openclaw/logs}"
mkdir -p "$LOG_DIR"
START_DASHBOARD="${AO_START_DASHBOARD:-0}"

# Match both direct "ao lifecycle-worker <project>" and node-wrapper command lines.
is_lifecycle_worker_running() {
  local project="$1"
  local escaped_project
  escaped_project="$(printf '%s' "$project" | sed 's/[][().*^$+?{}|\\]/\\&/g')"
  pgrep -f "lifecycle-worker[[:space:]].*${escaped_project}([[:space:]]|$)" > /dev/null 2>&1
}

# Default to NO stop-first in automation loops.
# Repeated ao stop/start cycles can kill healthy workers and create thrash.
if [ "${AO_START_STOP_FIRST:-0}" = "1" ]; then
  echo "Resetting stale AO runtime state (ao stop)..."
  "$AO_CLI" stop >/dev/null 2>&1 || true
fi
START_FAILURES=0

FIRST=true
for PROJECT in $SELECTED; do
  if ! echo "$PROJECTS" | grep -q "^${PROJECT}$"; then
    echo "SKIP: $PROJECT not found in config"
    continue
  fi

  START_LOG="$LOG_DIR/ao-start-${PROJECT}.log"
  if [ "$FIRST" = true ] && [ "$START_DASHBOARD" = "1" ]; then
    echo "=== Starting $PROJECT (with dashboard, async) ==="
    nohup "$AO_CLI" start "$PROJECT" > "$START_LOG" 2>&1 &
    START_PID=$!
    disown || true
    echo "  launched ao start for $PROJECT (pid=$START_PID, log=$START_LOG)"
  else
    echo "=== Starting $PROJECT lifecycle-worker (async) ==="
    # In no-dashboard mode, launch workers directly for every project.
    # Avoid ao start --no-dashboard keepalive wrappers that can mask missing workers.
    if is_lifecycle_worker_running "$PROJECT"; then
      echo "  lifecycle-worker $PROJECT already running — skipping"
    else
      nohup "$AO_CLI" lifecycle-worker "$PROJECT" > "$LOG_DIR/ao-lifecycle-${PROJECT}.log" 2>&1 &
      START_PID=$!
      disown || true
      echo "  launched lifecycle-worker for $PROJECT (pid=$START_PID, log=$LOG_DIR/ao-lifecycle-${PROJECT}.log)"
    fi
  fi
  FIRST=false
  echo ""
  sleep 1
done

# Post-start health check: verify workers are actually running
echo "Verifying workers..."
sleep 3
for PROJECT in $SELECTED; do
  if ! echo "$PROJECTS" | grep -q "^${PROJECT}$"; then
    continue
  fi
  if is_lifecycle_worker_running "$PROJECT"; then
    : # running
  else
    echo "WARNING: lifecycle-worker $PROJECT failed to start"
    START_FAILURES=1
  fi
done

if [ "$START_FAILURES" -ne 0 ]; then
  echo "ERROR: one or more lifecycle-workers failed verification"
  exit 1
fi

echo "All projects started."
echo "  Dashboard: http://localhost:${AO_PORT:-3020}"
echo "  Workers: ps aux | grep lifecycle-worker"
echo "  Sessions: ao session ls"
