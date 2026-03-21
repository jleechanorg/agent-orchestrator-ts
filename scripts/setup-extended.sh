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
if [ "$CI" = "true" ]; then
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

# Skip the old per-project plist generation
if false; then
  # ── OLD CODE (disabled) ── individual lifecycle-worker plists per project
  PLIST_DIR_OLD="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR_OLD"
  NODE_BIN=$(which node)
  AO_BIN=$(which ao)

  for PROJECT in placeholder; do
      PLIST_NAME="com.agentorchestrator.lifecycle-${PROJECT}"
      PLIST_PATH="$PLIST_DIR_OLD/${PLIST_NAME}.plist"
      LOG_DIR="$HOME/.openclaw/logs"
      mkdir -p "$LOG_DIR"

      # Kill existing worker for this project before starting a new one
      # This prevents duplicate workers when running setup-extended.sh repeatedly
      if launchctl list "$PLIST_NAME" 2>/dev/null | grep -q "PID"; then
        echo "  [kill] $PROJECT existing lifecycle-worker — unloading and restarting"
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
      fi
      # Also kill any non-launchd worker for this project (by PID file)
      # PID file path: ~/.agent-orchestrator/{hash}-{projectId}/lifecycle-worker.pid
      # hash = sha256(realpath(dirname(configPath)))[:12], projectId = basename(project.path)
      # Uses realpath to resolve symlinks — matches TypeScript generateConfigHash().
      if [ -d "$HOME/.agent-orchestrator" ]; then
        # Compute namespace hash from resolved config directory path (symlink-aware).
        PID_FILE_NS="$(python3 -c "
import hashlib, sys, os, yaml
try:
    cfg_path = os.path.realpath('$CONFIG_FILE')
    ns = hashlib.sha256(os.path.dirname(cfg_path).encode()).hexdigest()[:12]
    print(ns)
except:
    pass
" 2>/dev/null || echo "")"
        # projectId must be basename(project.path) — matches TypeScript generateProjectId().
        PROJ_ID_FOR_PID="$(python3 -c "
import yaml, sys, os
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
        if [ -n "$PID_FILE_NS" ]; then
          LW_PID_FILE="$HOME/.agent-orchestrator/${PID_FILE_NS}-${PROJ_ID_FOR_PID}/lifecycle-worker.pid"
          if [ -f "$LW_PID_FILE" ]; then
            LW_PID="$(cat "$LW_PID_FILE" 2>/dev/null)"
            if [ -n "$LW_PID" ]; then
              # Verify this PID is actually a lifecycle-worker before killing it
              # to avoid killing an unrelated process that has reused this PID.
              if ps -p "$LW_PID" -o args= 2>/dev/null | grep -qF -- "lifecycle-worker $PROJ_ID_FOR_PID"; then
                echo "  [kill] $PROJ_ID_FOR_PID lifecycle-worker PID $LW_PID"
                kill "$LW_PID" 2>/dev/null || true
              fi
            fi
          fi
        fi
      fi

      cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${AO_BIN}</string>
        <string>lifecycle-worker</string>
        <string>${PROJECT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/ao-lifecycle-${PROJECT}.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/ao-lifecycle-${PROJECT}.err.log</string>
    <key>WorkingDirectory</key>
    <string>${HOME}</string>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
PLIST_EOF

      # Load the plist
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      launchctl load "$PLIST_PATH" 2>/dev/null
      echo "  [ok] $PROJECT lifecycle-worker installed and started"
    done
  else
    echo "  Skipping launchd setup (no config or python3 missing)"
  fi

# ─── Clean stale PID files ─────────────────────────────────────────────────

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
