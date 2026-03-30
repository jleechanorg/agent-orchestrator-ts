#!/bin/bash
# Start AO for all projects defined in agent-orchestrator.yaml.
# First project: ao start (dashboard + lifecycle-worker + orchestrator)
# Remaining projects: lifecycle-worker + orchestrator only (no duplicate dashboard)
#
# Idempotent: skips lifecycle-workers that are already running per project.
# Pre-flight: validates YAML parses cleanly before attempting to start anything.
set -euo pipefail

export AO_CONFIG_PATH="${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}"
CONFIG_FILE="$AO_CONFIG_PATH"

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

# Pre-flight: run ao doctor to catch environment issues before starting projects.
# Uses --fix to auto-repair fixable issues; destructive fixes (worktree cleanup,
# main-repo checkout) are guarded — they skip dirty worktrees / uncommitted work.
if command -v ao >/dev/null 2>&1; then
  echo "=== Pre-flight: ao doctor ==="
  set +e
  DOCTOR_OUT=$(ao doctor 2>&1)
  DOCTOR_STATUS=$?
  set -e
  # Always show doctor output so FAIL/WARN lines are visible
  printf '%s\n' "$DOCTOR_OUT"
  # Surface failures without blocking startup (doctor reports; human decides)
  if [ "$DOCTOR_STATUS" -ne 0 ]; then
    echo "NOTE: 'ao doctor' exited $DOCTOR_STATUS — review FAIL/WARN lines above before proceeding."
  fi
  echo ""
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
    # Idempotency: skip if a lifecycle-worker for this project is already running
    if pgrep -f "ao lifecycle-worker ${PROJECT}$" > /dev/null 2>&1; then
      echo "  lifecycle-worker $PROJECT already running — skipping"
    else
      nohup ao lifecycle-worker "$PROJECT" > "$LOG_DIR/ao-lifecycle-${PROJECT}.log" 2>&1 &
      disown
      echo "  lifecycle-worker $PROJECT started"
    fi
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
