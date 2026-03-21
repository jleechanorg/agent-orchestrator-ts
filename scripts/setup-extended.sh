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

# ─── Install launchd lifecycle-workers ──────────────────────────────────────

echo ""
echo "Installing launchd lifecycle-workers..."

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"

# Read project IDs from config
if [ -f "$CONFIG_FILE" ] && command -v python3 &>/dev/null; then
  PROJECTS=$(python3 -c "
import yaml, sys
try:
    with open('$CONFIG_FILE') as f:
        cfg = yaml.safe_load(f)
    projects = cfg.get('projects', {})
    for pid in projects:
        print(pid)
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
" 2>/dev/null)

  if [ -z "$PROJECTS" ]; then
    echo "  Could not parse projects from config. Skipping launchd setup."
  else
    NODE_BIN=$(which node)
    AO_BIN=$(which ao)
    GH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

    for PROJECT in $PROJECTS; do
      PLIST_NAME="com.agentorchestrator.lifecycle-${PROJECT}"
      PLIST_PATH="$PLIST_DIR/${PLIST_NAME}.plist"
      LOG_DIR="$HOME/.openclaw/logs"
      mkdir -p "$LOG_DIR"

      # Skip if already loaded and running
      if launchctl list "$PLIST_NAME" 2>/dev/null | grep -q "PID"; then
        echo "  [ok] $PROJECT lifecycle-worker already running"
        continue
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
  fi
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
