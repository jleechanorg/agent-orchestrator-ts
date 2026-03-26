#!/usr/bin/env bash
# install-novel-daily.sh
# Symlinks the novel-daily launchd plist into ~/Library/LaunchAgents/
# with @REPO_ROOT@ substituted to the absolute path of the repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/launchd/ai.agento.novel-daily.plist.template"
DST_DIR="$HOME/Library/LaunchAgents"
DST="${DST_DIR}/ai.agento.novel-daily.plist"
LOG_FILE="${REPO_ROOT}/logs/novel-daily.log"

echo "=== Novel Daily LaunchAgent Installer ==="
echo "Repo root: $REPO_ROOT"
echo "Dest:      $DST"

# Ensure LaunchAgents directory exists
mkdir -p "$DST_DIR"

# Ensure logs directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Substitute @REPO_ROOT@, @HOME@, @PATH@, @LOG_FILE@ in the plist
sed \
  -e "s|@REPO_ROOT@|${REPO_ROOT}|g" \
  -e "s|@HOME@|${HOME}|g" \
  -e "s|@LOG_FILE@|${LOG_FILE}|g" \
  -e "s|@PATH@|${PATH}|g" \
  "$SRC" > "$DST"

chmod 644 "$DST"
echo "Plist written: $DST"

# Load the agent (won't re-trigger if already loaded — kickstart handles that separately)
if launchctl list | grep -q "ai.agento.novel-daily"; then
  echo "Agent already loaded — use 'launchctl kickstart -kp gui/\$(id -u)/ai.agento.novel-daily' to force a re-run now"
else
  launchctl load "$DST"
  echo "Agent loaded."
fi

echo ""
echo "Done. The agent will run daily at 06:00 Pacific."
echo "Log file: $LOG_FILE"
echo ""
echo "To trigger a test run now without waiting:"
echo "  launchctl kickstart -kp gui/\$(id -u)/ai.agento.novel-daily"
