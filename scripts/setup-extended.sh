#!/bin/bash
# Agent Orchestrator — jleechanorg fork extended setup
# Installs fork-specific services: launchd lifecycle-workers, config validation, ao rebuild
#
# Called by setup.sh after the base setup completes.
# Can also be run standalone: bash scripts/setup-extended.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}"

echo ""
echo "═══ Extended Setup (jleechanorg fork) ═══"
echo ""

# ─── Validate canonical config ─────────────────────────────────────────────

if [ ! -f "$CONFIG_FILE" ]; then
  echo "WARNING: No config found at $CONFIG_FILE"
  echo "  Create one or set AO_CONFIG_PATH to your agent-orchestrator.yaml"
else
  echo "[ok] Config: $CONFIG_FILE"
fi

# Check for duplicate configs that would create split namespaces
DUPES=$(find "$HOME" -maxdepth 4 -name "agent-orchestrator.yaml" \
  -not -path "*/node_modules/*" \
  -not -path "*/.agent-orchestrator/*" \
  -not -path "*/Dropbox/*" \
  -not -path "*/.worktrees/*" \
  -not -path "*/worktrees/*" \
  -not -path "*/backup/*" \
  2>/dev/null | grep -v "$(realpath "$CONFIG_FILE" 2>/dev/null)" || true)

if [ -n "$DUPES" ]; then
  echo ""
  echo "WARNING: Found duplicate agent-orchestrator.yaml files (potential namespace split):"
  echo "$DUPES" | while read -r f; do echo "  $f"; done
  echo ""
  echo "  Only $CONFIG_FILE should exist. Others create separate data namespaces."
  echo "  Remove duplicates or they will cause sessions to be invisible to the lifecycle-worker."
fi

# ─── Rebuild ao CLI from source ─────────────────────────────────────────────

echo ""
echo "Rebuilding ao CLI from source..."
cd "$REPO_ROOT"
pnpm build 2>&1 | tail -1

echo "Installing ao CLI globally..."
cd "$REPO_ROOT/packages/cli"
npm install -g . 2>/dev/null || sudo npm install -g .
cd "$REPO_ROOT"

AO_VERSION=$(ao --version 2>/dev/null || echo "unknown")
echo "[ok] ao $AO_VERSION installed"

# ─── Start all projects via ao start ────────────────────────────────────────

# Skip in CI environments — the onboarding test starts its own dashboard on
# a known port, and running ao start here would cause a port conflict.
if [ "${CI:-}" = "true" ]; then
  echo ""
  echo "Skipping 'ao start' in CI environment (onboarding test manages its own dashboard)."
else
  echo ""
  echo "Starting all projects..."

  START_ALL="$REPO_ROOT/scripts/start-all.sh"
  if [ -f "$START_ALL" ]; then
    bash "$START_ALL"
  else
    echo "  WARNING: scripts/start-all.sh not found. Run manually:"
    echo "    ao start <project-name>"
  fi

  # Keep service automation portable across machines: install launchd jobs from one
  # central script (lifecycle + novel). This is safe to rerun.
  if [ -x "$REPO_ROOT/scripts/setup-launchd.sh" ]; then
    echo ""
    echo "Installing launchd jobs from central installer..."
    bash "$REPO_ROOT/scripts/setup-launchd.sh" all
  else
    echo "  WARNING: scripts/setup-launchd.sh missing or not executable."
  fi
fi

# ─── Legacy launchd cleanup ─────────────────────────────────────────────────
# Remove old per-project lifecycle-worker plists (replaced by ao start)

PLIST_DIR="$HOME/Library/LaunchAgents"
for plist in "$PLIST_DIR"/com.agentorchestrator.lifecycle-*.plist; do
  [ -f "$plist" ] || continue
  label=$(basename "$plist" .plist)
  launchctl unload "$plist" 2>/dev/null
  rm -f "$plist"
  echo "  Removed legacy plist: $label"
done

# ─── Kill stale non-launchd lifecycle-workers per project ───────────────────
# Reads project IDs from config and verifies PID before sending signals.
# Uses word-boundary grep to prevent "api" from matching "api-v2".
if [ -f "$CONFIG_FILE" ] && [ -d "$HOME/.agent-orchestrator" ]; then
  PROJECTS="$(python3 -c "
import yaml, sys, os
try:
    with open('$CONFIG_FILE') as f:
        cfg = yaml.safe_load(f)
    for pid in cfg.get('projects', {}):
        print(pid)
except:
    pass
" 2>/dev/null || true)"
  if [ -n "$PROJECTS" ]; then
    # Compute namespace hash: sha256(realpath(dirname(configPath)))[:12]
    PID_FILE_NS="$(python3 -c "
import hashlib, os
try:
    cfg_path = os.path.realpath('$CONFIG_FILE')
    ns = hashlib.sha256(os.path.dirname(cfg_path).encode()).hexdigest()[:12]
    print(ns)
except:
    pass
" 2>/dev/null || echo "")"
    if [ -n "$PID_FILE_NS" ]; then
      for PROJECT in $PROJECTS; do
        # projectId = basename(project.path) — matches TypeScript generateProjectId()
        PROJ_ID_FOR_PID="$(python3 -c "
import yaml, os
try:
    with open('$CONFIG_FILE') as f:
        cfg = yaml.safe_load(f)
    proj_cfg = cfg.get('projects', {}).get('$PROJECT', {})
    path = proj_cfg.get('path', '')
    if path:
        if path.startswith('~'):
            path = os.path.expanduser(path)
        elif not os.path.isabs(path):
            path = os.path.normpath(os.path.join(os.path.dirname('$CONFIG_FILE'), path))
        print(os.path.basename(path))
except:
    pass
" 2>/dev/null || echo "")"
        PROJ_ID_FOR_PID="${PROJ_ID_FOR_PID:-$PROJECT}"
        LW_PID_FILE="$HOME/.agent-orchestrator/${PID_FILE_NS}-${PROJ_ID_FOR_PID}/lifecycle-worker.pid"
        if [ -f "$LW_PID_FILE" ]; then
          LW_PID="$(cat "$LW_PID_FILE" 2>/dev/null)"
          if [ -n "$LW_PID" ] && kill -0 "$LW_PID" 2>/dev/null; then
            # Verify: use word-boundary grep so "api" does not match "api-v2"
            if ps -p "$LW_PID" -o args= 2>/dev/null | grep -qE "\blifecycle-worker[[:space:]]+${PROJ_ID_FOR_PID}($|[[:space:]])"; then
              echo "  [kill] $PROJ_ID_FOR_PID lifecycle-worker PID $LW_PID"
              kill "$LW_PID" 2>/dev/null || true
            fi
          fi
        fi
      done
    fi
  fi
fi

# ─── Clean stale PID files ─────────────────────────────────────────────────
# Removes PID files whose PIDs are no longer running. Uses word-boundary
# grep so a project named "api" does not match processes for "api-v2".

echo ""
echo "Cleaning stale lifecycle-worker PID files..."
CLEANED=0
for pidfile in $(find "$HOME/.agent-orchestrator" -name "lifecycle-worker.pid" 2>/dev/null); do
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
    CLEANED=$((CLEANED + 1))
  fi
done
echo "  Cleaned $CLEANED stale PID files"

# ─── Done ───────────────────────────────────────────────────────────────────

echo ""
echo "═══ Extended setup complete ═══"
echo ""
echo "Lifecycle workers are running. Monitor with:"
echo "  ao session ls"
echo "  tail -f ~/.openclaw/logs/ao-lifecycle-*.log"
