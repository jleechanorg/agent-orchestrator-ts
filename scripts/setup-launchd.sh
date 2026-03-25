#!/bin/bash
# Generate and install launchd wrappers for AO lifecycle and novel automation jobs.
#
# lifecycle-all keeps AO lifecycle workers running/restarting when needed.
# novel-daily runs a deterministic prose aggregation once per day.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/launchd"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
BASE_LOG_DIR="$HOME/.openclaw/logs"
BASE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

action_script="${1:-all}"

# Escape &, \\ and | for safe use in sed s|old|new| replacement strings.
# Also escape XML special characters first so values are safe in plist XML strings.
escape_sed() {
  printf '%s' "$1" \
    | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' \
    | sed 's/[\&\\|]/\\&/g'
}

# Escape for shell double-quote context: $, `, \, ", !
escape_shell() {
  printf '%s' "$1" \
    | sed "s/'/'\\\\''/g; s/\$/\\\$/g; s/\"/\\\\\"/g; s/\`/\\\\\`/g; s/\\\\/\\\\\\\\/g; s/!/\\\\!/g"
}

path_for_launchd() {
  AO_BIN="$(command -v ao 2>/dev/null || true)"
  if [ -n "$AO_BIN" ]; then
    AO_DIR="$(dirname "$AO_BIN")"
    echo "${AO_DIR}:${BASE_PATH}"
  else
    echo "$BASE_PATH"
  fi
}

install_lifecycle_plist() {
  local template="$TEMPLATE_DIR/ai.agento.lifecycle-all.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.lifecycle-all.plist"
  local script="$REPO_ROOT/scripts/start-all.sh"
  local log_file="$BASE_LOG_DIR/ao-lifecycle.log"
  local label="ai.agento.lifecycle-all"

  if [ ! -f "$template" ]; then
    echo "ERROR: Missing template at $template"
    return 1
  fi

  if [ ! -x "$script" ]; then
    echo "ERROR: Missing or non-executable script: $script"
    return 1
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR" "$BASE_LOG_DIR"

  # Remove legacy per-project lifecycle-worker plists (replaced by ai.agento.lifecycle-all).
  for legacy_plist in "$LAUNCH_AGENTS_DIR"/com.agentorchestrator.lifecycle-*.plist; do
    [ -f "$legacy_plist" ] || continue
    legacy_label="$(basename "$legacy_plist" .plist)"
    launchctl bootout "gui/$(id -u)/$legacy_label" >/dev/null 2>&1 || true
    rm -f "$legacy_plist"
    echo "Removed legacy plist: $legacy_label"
  done

  local tmp_plist
  tmp_plist="$(mktemp)"
  local path_value
  path_value="$(escape_sed "$(path_for_launchd)")"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@START_ALL_SCRIPT@|$(escape_sed "$script")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 644 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$label"

  echo "Installed launchd: $plist_path"
}

install_novel_plist() {
  local template="$TEMPLATE_DIR/ai.agento.novel-daily.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.novel-daily.plist"
  local log_file="$BASE_LOG_DIR/ao-novel-daily.log"
  local label="ai.agento.novel-daily"

  if [ ! -f "$template" ]; then
    echo "ERROR: Missing template at $template"
    return 1
  fi

  if [ ! -f "$REPO_ROOT/scripts/novel/generate-daily-entry.mjs" ]; then
    echo "ERROR: Missing script: $REPO_ROOT/scripts/novel/generate-daily-entry.mjs"
    return 1
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR" "$BASE_LOG_DIR"

  local tmp_plist
  tmp_plist="$(mktemp)"
  local path_value
  path_value="$(escape_sed "$(path_for_launchd)")"

  # Resolve absolute node path so launchd doesn't depend on PATH lookup.
  local node_path
  node_path="$(command -v node 2>/dev/null || echo "")"
  if [ -z "$node_path" ] || [ ! -x "$node_path" ]; then
    echo "ERROR: node not found in PATH"
    return 1
  fi

  # Build and shell-escape the run command.
  local run_cmd
  run_cmd="cd $(escape_shell "$REPO_ROOT") ; NODE_ENV=production $(escape_shell "$node_path") scripts/novel/generate-daily-entry.mjs --file novel/the-daily-lives-of-workers.md --days 1 --words 1000"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@GENERATE_DAILY_SCRIPT@|$(escape_sed "$run_cmd")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 644 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true

  echo "Installed launchd: $plist_path"
}

case "$action_script" in
  all)
    install_lifecycle_plist
    install_novel_plist
    ;;
  lifecycle)
    install_lifecycle_plist
    ;;
  novel)
    install_novel_plist
    ;;
  *)
    echo "ERROR: Unknown mode '$action_script'. Use all|lifecycle|novel"
    exit 1
    ;;
esac

echo "Log: $BASE_LOG_DIR"
echo "Check lifecycle status: launchctl print gui/$(id -u)/ai.agento.lifecycle-all"
echo "Check novel status: launchctl print gui/$(id -u)/ai.agento.novel-daily"