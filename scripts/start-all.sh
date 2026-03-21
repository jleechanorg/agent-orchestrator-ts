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

FIRST=true
for PROJECT in $SELECTED; do
  # Verify project exists in config
  if ! echo "$PROJECTS" | grep -q "^${PROJECT}$"; then
    echo "SKIP: $PROJECT not found in config"
    continue
  fi

  if [ "$FIRST" = true ]; then
    echo "=== Starting $PROJECT (with dashboard) ==="
    ao start "$PROJECT" 2>&1 | grep -E "✔|✓|Dashboard:|Lifecycle:|Orchestrator:|error" | head -5
    FIRST=false
  else
    echo "=== Starting $PROJECT ==="
    ao start --no-dashboard "$PROJECT" 2>&1 | grep -E "✔|✓|Lifecycle:|Orchestrator:|error" | head -5
  fi
  echo ""
  sleep 2
done

echo "All projects started."
echo ""
echo "Status:  ao status"
echo "Workers: ps aux | grep lifecycle-worker | grep -v grep"
echo "Sessions: ao session ls"
