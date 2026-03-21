#!/bin/bash
# Start AO for all projects defined in agent-orchestrator.yaml.
# For persistent restarts/login startup, install the launchd wrapper via scripts/setup-launchd.sh.
# First project gets the dashboard, rest get --no-dashboard.
set -euo pipefail

CONFIG_FILE="${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config not found at $CONFIG_FILE"
  exit 1
fi

# Parse project IDs from config
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

# Optional: specify which projects to start (default: all)
SELECTED="${@:-$PROJECTS}"

LOG_DIR="${AO_LOG_DIR:-$HOME/.openclaw/logs}"
mkdir -p "$LOG_DIR"

# Track worker PIDs for monitoring and cleanup.
PIDS=()
# Trap to kill all workers on exit (prevents orphaned processes on restart).
# _kill_workers guards against empty PIDS to avoid bash 3.2 "unbound variable"
# errors with "${PIDS[@]}" under set -u.
_kill_workers() {
  if [ ${#PIDS[@]} -eq 0 ]; then return; fi
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null || true
  done
}
trap '_kill_workers' EXIT

FIRST=true
for PROJECT in $SELECTED; do
  # Verify project exists in config
  if ! echo "$PROJECTS" | grep -q "^${PROJECT}$"; then
    echo "SKIP: $PROJECT not found in config"
    continue
  fi

  AO_LOG="$LOG_DIR/ao-start-${PROJECT}.log"

  if [ "$FIRST" = true ]; then
    echo "=== Starting $PROJECT (with dashboard) ==="
    # Run ao start in background so the dashboard process persists after this
    # script exits. The lifecycle-worker is already detached (detached:true +
    # unref) but ao start itself blocks to keep the dashboard alive — running
    # it via nohup+disown ensures both the dashboard AND the lifecycle-worker
    # survive parent exit.
    nohup ao start "$PROJECT" > "$AO_LOG" 2>&1 &
    PIDS+=($!)
    FIRST=false
    # Wait briefly for startup output, then display summary lines
    sleep 3
    grep -E "✔|✓|Dashboard:|Lifecycle:|Orchestrator:|error" "$AO_LOG" | head -5 || true
  else
    echo "=== Starting $PROJECT ==="
    nohup ao start --no-dashboard "$PROJECT" > "$AO_LOG" 2>&1 &
    PIDS+=($!)
    sleep 3
    grep -E "✔|✓|Lifecycle:|Orchestrator:|error" "$AO_LOG" | head -5 || true
  fi
  echo ""
done

if [ ${#PIDS[@]} -eq 0 ]; then
  echo "ERROR: No workers started"
  exit 1
fi

echo "Monitoring ${#PIDS[@]} workers. If any exit, this wrapper will exit too (triggering launchd restart)."

# Wait for any worker to exit (bash 3.2 compatible — no wait -n).
# Uses kill -0 to check liveness without sending a signal.
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      EXIT_CODE=0
      wait "$pid" 2>/dev/null || EXIT_CODE=$?
      echo "Worker PID $pid exited with code ${EXIT_CODE}. Exiting wrapper to trigger launchd restart."
      _kill_workers
      exit "$EXIT_CODE"
    fi
  done
  sleep 2
done
