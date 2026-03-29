#!/bin/bash
# Installs com.ao-runner-watchdog launchd plist with install-time path substitution.
#
# Substitutes @HOME@ and @PATH@ templates:
#   @HOME@  → $HOME
#   @PATH@  → resolved from PATH (ao binary dir prepended)
#
# Usage:
#   ./scripts/install-runner-watchdog.sh    # install
#   ./scripts/install-runner-watchdog.sh --uninstall  # uninstall

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/launchd/com.ao-runner-watchdog.plist.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/com.ao-runner-watchdog.plist"
LABEL="com.ao-runner-watchdog"
ACTION="${1:-install}"

if [ "$ACTION" = "--uninstall" ] || [ "$ACTION" = "uninstall" ]; then
  if [ ! -f "$PLIST_PATH" ]; then
    echo "Already uninstalled: $PLIST_PATH not found"
    exit 0
  fi
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  echo "Uninstalled: $LABEL"
  exit 0
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: Template not found: $TEMPLATE"
  exit 1
fi

# Resolve ao binary path for launchd environment
resolve_path() {
  local ao_bin
  ao_bin="$(command -v ao 2>/dev/null || true)"
  if [ -n "$ao_bin" ]; then
    local ao_dir
    ao_dir="$(dirname "$ao_bin")"
    echo "${ao_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  else
    echo "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  fi
}

PATH_VALUE="$(resolve_path)"

mkdir -p "$LAUNCH_AGENTS_DIR" "$HOME/Library/Logs/ao-runner-watchdog"

# Escape for sed replacement strings.
# First pass: XML entities (&, <, >) so they survive the second sed pass.
# Second pass: sed delimiter chars (&, \, |) to prevent s/// misinterpretation.
escape_sed() {
  printf '%s' "$1" \
    | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' \
    | sed 's/[\&\\|]/\\&/g'
}

TMP_PLIST="$(mktemp)"
sed -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@PATH@|$(escape_sed "$PATH_VALUE")|g" \
    "$TEMPLATE" > "$TMP_PLIST"

plutil -lint "$TMP_PLIST" >/dev/null || {
  echo "ERROR: plist validation failed for $TMP_PLIST"
  rm -f "$TMP_PLIST"
  exit 1
}
install -m 644 "$TMP_PLIST" "$PLIST_PATH"
rm -f "$TMP_PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

echo "Installed: $PLIST_PATH"
echo "State: $(launchctl print "gui/$(id -u)/$LABEL" 2>&1 | grep -F 'state =' || echo "check with: launchctl print gui/$(id -u)/com.ao-runner-watchdog")"
