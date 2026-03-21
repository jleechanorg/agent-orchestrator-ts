#!/bin/bash
# Start AO for all projects defined in agent-orchestrator.yaml
# First project gets the dashboard, rest get --no-dashboard
set -e

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
    disown
    FIRST=false
    # Wait briefly for startup output, then display summary lines
    sleep 3
    grep -E "✔|✓|Dashboard:|Lifecycle:|Orchestrator:|error" "$AO_LOG" | head -5 || true
  else
    echo "=== Starting $PROJECT ==="
    nohup ao start --no-dashboard "$PROJECT" > "$AO_LOG" 2>&1 &
    disown
    sleep 3
    grep -E "✔|✓|Lifecycle:|Orchestrator:|error" "$AO_LOG" | head -5 || true
  fi
  echo ""
done

echo "All projects started."
echo ""
echo "Status:  ao status"
echo "Workers: ps aux | grep lifecycle-worker | grep -v grep"
echo "Sessions: ao session ls"
echo "Logs:    ls $LOG_DIR/ao-start-*.log"
