#!/bin/bash
# Generate and install launchd wrapper for scripts/start-all.sh.
# This keeps AO lifecycle workers restarted via launchd KeepAlive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/launchd/ai.agento.lifecycle-all.plist.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/ai.agento.lifecycle-all.plist"
TMP_PLIST="$(mktemp)"
START_ALL_SCRIPT="$REPO_ROOT/scripts/start-all.sh"
LOG_FILE="$HOME/.openclaw/logs/ao-lifecycle.log"
LABEL="ai.agento.lifecycle-all"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: Missing template at $TEMPLATE"
  exit 1
fi

if [ ! -x "$START_ALL_SCRIPT" ]; then
  echo "ERROR: Missing or non-executable script: $START_ALL_SCRIPT"
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$(dirname "$LOG_FILE")"

sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@REPO_ROOT@|$REPO_ROOT|g" \
  -e "s|@START_ALL_SCRIPT@|$START_ALL_SCRIPT|g" \
  -e "s|@LOG_FILE@|$LOG_FILE|g" \
  "$TEMPLATE" > "$TMP_PLIST"

plutil -lint "$TMP_PLIST" >/dev/null
install -m 644 "$TMP_PLIST" "$PLIST_PATH"
rm -f "$TMP_PLIST"

# Reload the LaunchAgent if already present, then bootstrap and start it.
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed: $PLIST_PATH"
echo "Label: $LABEL"
echo "Log: $LOG_FILE"
echo "Check status: launchctl print gui/$(id -u)/$LABEL"
