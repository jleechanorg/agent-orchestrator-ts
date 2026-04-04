#!/bin/bash
# Generate and install launchd wrappers for AO lifecycle and novel automation jobs.
#
# lifecycle-all keeps AO lifecycle workers running/restarting when needed.
# novel-daily runs a deterministic prose aggregation once per day.

set -euo pipefail

# Resolve REPO_ROOT. For the agent-orchestrator fork, prefer the canonical
# project path over ephemeral AO worktrees so the launchd plist is stable.
# AO worktrees (name matching ^ao-[0-9]+$) may be removed when sessions end.
_resolve_repo_root() {
  local _script_dir="$(cd "$(dirname "$0")/.." && pwd)"
  # Check if script dir looks like an AO-managed ephemeral worktree
  local _basename="$(basename "$_script_dir")"
  if [[ "$_basename" =~ ^ao-[0-9]+$ ]] && [[ -d "/Users/jleechan/project_agento/agent-orchestrator" ]]; then
    echo "/Users/jleechan/project_agento/agent-orchestrator"
  else
    echo "$_script_dir"
  fi
}

REPO_ROOT="$(_resolve_repo_root)"
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
# Handle \ first so that subsequent replacements (which may introduce new \ chars) are not double-escaped.
escape_shell() {
  printf '%s' "$1" \
    | sed 's/\\/\\\\/g; s/'"'"'/'"'"'"'"'"'"'"'"'/g; s/\$/\\$/g; s/"/\\"/g; s/`/\\`/g; s/!/\\!/g'
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
  if [ ! -f "$REPO_ROOT/scripts/novel/run-daily.sh" ]; then
    echo "ERROR: Missing script: $REPO_ROOT/scripts/novel/run-daily.sh"
    return 1
  fi
  if [ ! -x "$REPO_ROOT/scripts/novel/run-daily.sh" ]; then
    echo "ERROR: not executable: $REPO_ROOT/scripts/novel/run-daily.sh — run: chmod +x scripts/novel/run-daily.sh"
    return 1
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR" "$BASE_LOG_DIR"

  local tmp_plist
  tmp_plist="$(mktemp)"
  local path_value
  path_value="$(escape_sed "$(path_for_launchd)")"

  # Build the run command — delegates date-computation and node-resolution to run-daily.sh.
  # The wrapper computes today's date at RUNTIME (not at plist-install time), ensuring
  # each daily run writes to the correct novel/workers/{YYYY-MM-DD}.md file.
  local run_wrapper="$REPO_ROOT/scripts/novel/run-daily.sh"
  local run_cmd
  printf -v run_cmd \
    'cd %q && %q' \
    "$REPO_ROOT" \
    "$run_wrapper"

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

install_watchdog_plist() {
  local template="$TEMPLATE_DIR/ai.agento.lw-watchdog.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.lw-watchdog.plist"
  local script="$REPO_ROOT/scripts/lw-watchdog.sh"
  local log_file="$BASE_LOG_DIR/lw-watchdog.log"
  local label="ai.agento.lw-watchdog"

  if [ ! -f "$template" ]; then
    echo "WARN: Missing watchdog template at $template — skipping"
    return 0
  fi

  if [ ! -f "$script" ]; then
    echo "WARN: Missing watchdog script: $script — skipping"
    return 0
  fi

  chmod +x "$script" 2>/dev/null || true

  mkdir -p "$LAUNCH_AGENTS_DIR" "$BASE_LOG_DIR"

  local tmp_plist
  tmp_plist="$(mktemp)"
  local path_value
  path_value="$(escape_sed "$(path_for_launchd)")"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@WATCHDOG_SCRIPT@|$(escape_sed "$script")|g" \
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
    install_watchdog_plist
    ;;
  lifecycle)
    install_lifecycle_plist
    ;;
  novel)
    install_novel_plist
    ;;
  watchdog)
    install_watchdog_plist
    ;;
  *)
    echo "ERROR: Unknown mode '$action_script'. Use all|lifecycle|novel|watchdog"
    exit 1
    ;;
esac

echo "Log: $BASE_LOG_DIR"
echo "Check lifecycle status: launchctl print gui/$(id -u)/ai.agento.lifecycle-all"
echo "Check novel status: launchctl print gui/$(id -u)/ai.agento.novel-daily"
echo "Check watchdog status: launchctl print gui/$(id -u)/ai.agento.lw-watchdog"