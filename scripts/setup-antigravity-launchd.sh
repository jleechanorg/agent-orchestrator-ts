#!/bin/bash
# Generate and install launchd plist for the antigravity orchestrator.
# This keeps the antigravity build orchestrator restarted via launchd KeepAlive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/launchd/ai.agento.antigravity-orch.plist.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/ai.agento.antigravity-orch.plist"
TMP_PLIST="$(mktemp)"
trap 'rm -f "$TMP_PLIST"' EXIT
WORKING_DIR="$HOME/project_agento/worktree_antigravity_orch"
LOG_FILE="$HOME/.openclaw/logs/ao-antigravity-orch.log"
LABEL="ai.agento.antigravity-orch"
PROMPT_FILE="$HOME/.antigravity-loop/orchestrator-prompt.md"

# Escape &, \ and | for safe use in sed s|old|new| replacement strings.
escape_sed() {
  printf '%s' "$1" | sed 's/[\&\\|]/\\&/g'
}

WORKING_DIR_ESCAPED="$(escape_sed "$WORKING_DIR")"
LOG_FILE_ESCAPED="$(escape_sed "$LOG_FILE")"
HOME_ESCAPED="$(escape_sed "$HOME")"

# Dynamically build PATH: include nvm node, homebrew, ~/bin, and base system paths.
BASE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NVM_PATH="$HOME/.nvm/versions/node"
if [ -d "$NVM_PATH" ]; then
  LATEST_NODE="$(ls -d "$NVM_PATH"/*/bin 2>/dev/null | head -1)"
  if [ -n "$LATEST_NODE" ]; then
    NVM_NODE_DIR="$(dirname "$LATEST_NODE")"
    FULL_PATH="${NVM_NODE_DIR}:${BASE_PATH}"
  else
    FULL_PATH="$BASE_PATH"
  fi
else
  FULL_PATH="$BASE_PATH"
fi
PATH_ESCAPED="$(escape_sed "$FULL_PATH")"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: Missing template at $TEMPLATE"
  exit 1
fi

if [ ! -d "$WORKING_DIR" ]; then
  echo "ERROR: Working directory not found: $WORKING_DIR"
  echo "Create it with: git -C $REPO_ROOT worktree add '$WORKING_DIR' origin/main"
  exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Orchestrator prompt not found: $PROMPT_FILE"
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$(dirname "$LOG_FILE")"

sed \
  -e "s|@HOME@|${HOME_ESCAPED}|g" \
  -e "s|@WORKING_DIR@|${WORKING_DIR_ESCAPED}|g" \
  -e "s|@LOG_FILE@|${LOG_FILE_ESCAPED}|g" \
  -e "s|@PATH@|${PATH_ESCAPED}|g" \
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
echo "Working dir: $WORKING_DIR"
echo "Log: $LOG_FILE"
echo "Check status: launchctl print gui/$(id -u)/$LABEL"
