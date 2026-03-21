#!/bin/bash
# Start AO for all projects defined in agent-orchestrator.yaml.
# First project: ao start (dashboard + lifecycle-worker + orchestrator)
# Remaining projects: lifecycle-worker + orchestrator only (no duplicate dashboard)
set -euo pipefail

CONFIG_FILE="${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config not found at $CONFIG_FILE"
  exit 1
fi

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
LOG_DIR="${AO_LOG_DIR:-$HOME/.openclaw/logs}"
mkdir -p "$LOG_DIR"

FIRST=true
for PROJECT in $SELECTED; do
  if ! echo "$PROJECTS" | grep -q "^${PROJECT}$"; then
    echo "SKIP: $PROJECT not found in config"
    continue
  fi

  if [ "$FIRST" = true ]; then
    echo "=== Starting $PROJECT (with dashboard) ==="
    ao start "$PROJECT" 2>&1 | grep -E "✔|✓|Dashboard:|Lifecycle:|Orchestrator:|error" | head -6 || true
    FIRST=false
  else
    echo "=== Starting $PROJECT (worker + orchestrator) ==="
    # Start lifecycle-worker (detached, survives this script)
    nohup ao lifecycle-worker "$PROJECT" > "$LOG_DIR/ao-lifecycle-${PROJECT}.log" 2>&1 &
    disown
    # Start orchestrator if not already running
    ao start --no-dashboard "$PROJECT" 2>&1 | grep -E "✔|✓|Orchestrator:|error" | head -3 || true
  fi
  echo ""
  sleep 2
done

echo "All projects started."
echo "  Dashboard: http://localhost:${AO_PORT:-3020}"
echo "  Workers: ps aux | grep lifecycle-worker"
echo "  Sessions: ao session ls"
