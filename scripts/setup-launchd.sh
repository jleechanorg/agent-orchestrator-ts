#!/bin/bash
# Generate and install launchd wrappers for AO lifecycle and novel automation jobs.
#
# lifecycle-all keeps AO lifecycle workers running/restarting when needed.
# novel-daily runs a deterministic prose aggregation once per day.
#
# All plists use scripts/launchd-launcher.sh which sources the shell profile
# for secrets (API keys). PATH is still set in the plist because nvm/node
# init requires more than just HOME in the launchd minimal env.

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

path_for_launchd() {
  AO_BIN="$(command -v ao 2>/dev/null || true)"
  if [ -n "$AO_BIN" ]; then
    AO_DIR="$(dirname "$AO_BIN")"
    echo "${AO_DIR}:${BASE_PATH}"
  else
    echo "$BASE_PATH"
  fi
}

escape_ere() {
  printf '%s' "$1" | sed 's/[][().*^$+?{}|\\]/\\&/g'
}

resolve_path() {
  python3 - "$1" <<'PY' 2>/dev/null || printf '%s\n' "$1"
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
}

command_matches_ao_worker() {
  local cmd="$1"
  local ao_bin="$2"
  local escaped_project="$3"
  local ao_real
  local ao_bin_alt
  local ao_real_alt

  ao_real="$(resolve_path "$ao_bin")"
  ao_bin_alt="${ao_bin#/private}"
  ao_real_alt="${ao_real#/private}"
  [[ "$cmd" =~ lifecycle-worker[[:space:]].*${escaped_project}([[:space:]]|$) ]] || return 1
  [[ "$cmd" == *"$ao_bin"* || "$cmd" == *"$ao_bin_alt"* || "$cmd" == *"$ao_real"* || "$cmd" == *"$ao_real_alt"* ]]
}

configured_lifecycle_projects() {
  local config_file="${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}"
  if [ ! -f "$config_file" ]; then
    return 0
  fi

  python3 - "$config_file" <<'PY'
import sys
try:
    import yaml
except ImportError as exc:
    print(f"ERROR: PyYAML is required to parse lifecycle projects: {exc}", file=sys.stderr)
    sys.exit(1)

try:
    with open(sys.argv[1]) as f:
        cfg = yaml.safe_load(f) or {}
except yaml.YAMLError as exc:
    print(f"ERROR: Failed to parse lifecycle project config: {exc}", file=sys.stderr)
    sys.exit(1)
except Exception as exc:
    print(f"ERROR: Failed to read lifecycle project config: {exc}", file=sys.stderr)
    sys.exit(1)

if not isinstance(cfg, dict):
    print("ERROR: Lifecycle project config must be a mapping at the top level", file=sys.stderr)
    sys.exit(1)

projects = cfg.get("projects", {})
if isinstance(projects, dict):
    for project_id in projects:
        print(project_id)
PY
}

kill_stale_lifecycle_workers_for_config() {
  local ao_bin
  ao_bin="$(command -v ao 2>/dev/null || true)"
  if [ -z "$ao_bin" ]; then
    echo "Skipping stale lifecycle-worker cleanup: ao binary not found on PATH"
    return 0
  fi

  local projects
  if ! projects="$(configured_lifecycle_projects 2>&1)"; then
    echo "WARNING: Failed to parse lifecycle projects from config; skipping stale lifecycle-worker cleanup"
    echo "$projects"
    return 0
  fi
  if [ -z "$projects" ]; then
    echo "Skipping stale lifecycle-worker cleanup: no configured projects found"
    return 0
  fi

  local project escaped_project pids pid cmd terminated_pids remaining_pids killed_any
  killed_any=0
  while IFS= read -r project; do
    [ -n "$project" ] || continue
    escaped_project="$(escape_ere "$project")"
    pids="$(pgrep -f "lifecycle-worker[[:space:]].*${escaped_project}([[:space:]]|$)" 2>/dev/null || true)"
    [ -n "$pids" ] || continue

    terminated_pids=""
    for pid in $pids; do
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      [ -n "$cmd" ] || continue
      if ! command_matches_ao_worker "$cmd" "$ao_bin" "$escaped_project"; then
        echo "Skipping lifecycle-worker pid=$pid for $project (different ao path): $cmd"
        continue
      fi
      # Log matched PID+cmd before killing for audit trail
      echo "  Killing stale lifecycle-worker pid=$pid: $cmd"
      if kill "$pid" 2>/dev/null; then
        killed_any=1
        terminated_pids="$terminated_pids $pid"
      fi
    done

    [ -n "$terminated_pids" ] || continue

    # Bounded wait: only watch PIDs already scoped to this ao binary/project.
    remaining_pids=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      remaining_pids=""
      for pid in $terminated_pids; do
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        if command_matches_ao_worker "$cmd" "$ao_bin" "$escaped_project"; then
          remaining_pids="$remaining_pids $pid"
        fi
      done
      [ -n "$remaining_pids" ] || break
      sleep 1
    done

    if [ -n "$remaining_pids" ]; then
      echo "  Escalating to SIGKILL for remaining PIDs: $remaining_pids"
      for pid in $remaining_pids; do
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        if command_matches_ao_worker "$cmd" "$ao_bin" "$escaped_project"; then
          kill -9 "$pid" 2>/dev/null || true
        fi
      done
    fi
  done <<< "$projects"

  if [ "$killed_any" -eq 1 ]; then
    echo "Confirmed stale lifecycle-worker shutdown before launchd restart"
  fi
}

install_lifecycle_plist() {
  local template="$TEMPLATE_DIR/ai.agento.lifecycle-all.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.lifecycle-all.plist"
  local script="$REPO_ROOT/scripts/start-all.sh"
  local launcher="$REPO_ROOT/scripts/launchd-launcher.sh"
  local log_file="$BASE_LOG_DIR/ao-lifecycle.log"
  local label="ai.agento.lifecycle-all"

  if [ ! -f "$template" ]; then
    echo "ERROR: Missing template at $template"
    return 1
  fi

  if [ ! -x "$launcher" ]; then
    echo "ERROR: Missing or non-executable launcher: $launcher"
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
  local claude_binary_path
  # Prefer CLAUDE_BINARY (existing convention), fall back to CLAUDE_BINARY_PATH, then default.
  claude_binary_path="${CLAUDE_BINARY:-${CLAUDE_BINARY_PATH:-$HOME/.local/bin/claude}}"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@LAUNCHER_SCRIPT@|$(escape_sed "$launcher")|g" \
    -e "s|@START_ALL_SCRIPT@|$(escape_sed "$script")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    -e "s|@CLAUDE_BINARY@|$(escape_sed "$claude_binary_path")|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 600 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  # Kill only lifecycle-workers for the configured projects and this install's
  # ao binary so launchd restarts them with the new plist env.
  kill_stale_lifecycle_workers_for_config

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  # kickstart restarts the job immediately so new env takes effect without waiting
  # for the next StartInterval (5 min). Workers killed above will be respawned by
  # launchd with the fresh plist env; start-all.sh's skip-healthy logic won't
  # trigger since the workers are freshly launched.
  launchctl kickstart -k "gui/$(id -u)/$label" || true

  # Post-install verification: confirm env vars propagated from shell profile
  if [ -x "$REPO_ROOT/scripts/test-launchd-env.sh" ]; then
    echo "Verifying env var propagation..."
    "$REPO_ROOT/scripts/test-launchd-env.sh" || echo "WARNING: env var check failed — workers may not authenticate with MiniMax"
  fi

  echo "Installed launchd: $plist_path"
}

install_novel_plist() {
  local template="$TEMPLATE_DIR/ai.agento.novel-daily.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.novel-daily.plist"
  local launcher="$REPO_ROOT/scripts/launchd-launcher.sh"
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
  local run_wrapper="$REPO_ROOT/scripts/novel/run-daily.sh"
  local run_cmd
  printf -v run_cmd \
    'cd %q && %q' \
    "$REPO_ROOT" \
    "$run_wrapper"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@LAUNCHER_SCRIPT@|$(escape_sed "$launcher")|g" \
    -e "s|@GENERATE_DAILY_SCRIPT@|$(escape_sed "$run_cmd")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 600 "$tmp_plist" "$plist_path"
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
  local launcher="$REPO_ROOT/scripts/launchd-launcher.sh"
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
    -e "s|@LAUNCHER_SCRIPT@|$(escape_sed "$launcher")|g" \
    -e "s|@WATCHDOG_SCRIPT@|$(escape_sed "$script")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 600 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true

  echo "Installed launchd: $plist_path"
}

if [ "${AO_SETUP_LAUNCHD_SOURCE_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# ── Deprecated plist cleanup ─────────────────────────────────────────────────
# Remove plists superseded by the unified ai.agento.health job.
DEPRECATED_LABELS=(
  "ai.agento.lifecycle-all"
  "ai.agento.lw-watchdog"
  "com.agentorchestrator.lw-watchdog"
  "com.agentorchestrator.orch-watchdog"
  "com.agentorchestrator.start-all"
)

cleanup_deprecated_plists() {
  local label plist_basename plist_path
  for label in "${DEPRECATED_LABELS[@]}"; do
    plist_basename="$label.plist"
    plist_path="$LAUNCH_AGENTS_DIR/$plist_basename"
    if [ -f "$plist_path" ]; then
      launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
      rm -f "$plist_path"
      echo "Removed deprecated plist: $label"
    fi
  done
  # Also clean up legacy per-project lifecycle plists (com.agentorchestrator.lifecycle-<project>.plist)
  # These were created by older setup-launchd.sh versions before the unified health job.
  for legacy_plist in "$LAUNCH_AGENTS_DIR"/com.agentorchestrator.lifecycle-*.plist; do
    if [ -f "$legacy_plist" ]; then
      legacy_label="$(basename "$legacy_plist" .plist)"
      launchctl bootout "gui/$(id -u)/$legacy_label" >/dev/null 2>&1 || true
      rm -f "$legacy_plist"
      echo "Removed legacy per-project plist: $legacy_label"
    fi
  done
}

# ── Unified health job ───────────────────────────────────────────────────────
install_health_plist() {
  local template="$TEMPLATE_DIR/ai.agento.health.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.health.plist"
  local script="$REPO_ROOT/scripts/ao-health.sh"
  local launcher="$REPO_ROOT/scripts/launchd-launcher.sh"
  local log_file="$BASE_LOG_DIR/ao-health.log"
  local label="ai.agento.health"

  if [ ! -f "$template" ]; then
    echo "ERROR: Missing template at $template"
    return 1
  fi

  if [ ! -x "$launcher" ]; then
    echo "ERROR: Missing or non-executable launcher: $launcher"
    return 1
  fi

  if [ ! -x "$script" ]; then
    echo "ERROR: Missing or non-executable script: $script"
    return 1
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR" "$BASE_LOG_DIR"

  # Kill lifecycle-workers so they restart under the new job's management.
  kill_stale_lifecycle_workers_for_config

  # Remove deprecated plists that the unified job replaces.
  cleanup_deprecated_plists

  local tmp_plist
  tmp_plist="$(mktemp)"
  local path_value
  path_value="$(escape_sed "$(path_for_launchd)")"
  local claude_binary_path
  claude_binary_path="${CLAUDE_BINARY:-${CLAUDE_BINARY_PATH:-$HOME/.local/bin/claude}}"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@LAUNCHER_SCRIPT@|$(escape_sed "$launcher")|g" \
    -e "s|@HEALTH_SCRIPT@|$(escape_sed "$script")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    -e "s|@CLAUDE_BINARY@|$(escape_sed "$claude_binary_path")|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 600 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$label" || true

  # Post-install verification: confirm env vars propagated from shell profile
  if [ -x "$REPO_ROOT/scripts/test-launchd-env.sh" ]; then
    echo "Verifying env var propagation..."
    "$REPO_ROOT/scripts/test-launchd-env.sh" || echo "WARNING: env var check failed — workers may not authenticate"
  fi

  echo "Installed launchd: $plist_path"
}

install_health_guardian_plist() {
  local template="$TEMPLATE_DIR/ai.agento.health-guardian.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.agento.health-guardian.plist"
  local script="$REPO_ROOT/scripts/ai.agento.health-guardian.sh"
  local launcher="$REPO_ROOT/scripts/launchd-launcher.sh"
  local log_file="$BASE_LOG_DIR/ao-health-guardian.log"
  local label="ai.agento.health-guardian"

  if [ ! -f "$template" ]; then
    echo "ERROR: Missing template at $template"
    return 1
  fi

  if [ ! -x "$launcher" ]; then
    echo "ERROR: Missing or non-executable launcher: $launcher"
    return 1
  fi

  if [ ! -f "$script" ]; then
    echo "ERROR: Missing script: $script"
    return 1
  fi

  chmod +x "$script" 2>/dev/null || true

  mkdir -p "$LAUNCH_AGENTS_DIR" "$BASE_LOG_DIR"

  local tmp_plist
  tmp_plist="$(mktemp)"
  local path_value
  path_value="$(escape_sed "$(path_for_launchd)")"

  local slack_bot_token=""
  local slack_user_token=""

  slack_bot_token=$(bash -lic 'echo "${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${OPENCLAW_SLACK_BOT_TOKEN:-${HERMES_SLACK_BOT_TOKEN:-}}}"' 2>/dev/null || true)
  if [ -z "$slack_bot_token" ]; then
    slack_bot_token=$(bash -ic 'source ~/.bashrc 2>/dev/null; echo "${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${OPENCLAW_SLACK_BOT_TOKEN:-${HERMES_SLACK_BOT_TOKEN:-}}}"' 2>/dev/null || true)
  fi

  slack_user_token=$(bash -lic 'echo "$SLACK_USER_TOKEN"' 2>/dev/null || true)
  if [ -z "$slack_user_token" ]; then
    slack_user_token=$(bash -ic 'source ~/.bashrc 2>/dev/null; echo "$SLACK_USER_TOKEN"' 2>/dev/null || true)
  fi

  # Fallback to current process env if profile sourcing is empty
  [ -z "$slack_bot_token" ] && slack_bot_token="${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${OPENCLAW_SLACK_BOT_TOKEN:-${HERMES_SLACK_BOT_TOKEN:-}}}"
  [ -z "$slack_user_token" ] && slack_user_token="${SLACK_USER_TOKEN:-}"

  [ -z "$slack_bot_token" ] && slack_bot_token="__SET_BY_SETUP_LAUNCHD__"
  [ -z "$slack_user_token" ] && slack_user_token="__SET_BY_SETUP_LAUNCHD__"

  sed \
    -e "s|@HOME@|$(escape_sed "$HOME")|g" \
    -e "s|@REPO_ROOT@|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|@LAUNCHER_SCRIPT@|$(escape_sed "$launcher")|g" \
    -e "s|@LOG_FILE@|$(escape_sed "$log_file")|g" \
    -e "s|@PATH@|$path_value|g" \
    -e "s|@SLACK_BOT_TOKEN@|$(escape_sed "$slack_bot_token")|g" \
    -e "s|@SLACK_USER_TOKEN@|$(escape_sed "$slack_user_token")|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 600 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$label" || true

  echo "Installed launchd: $plist_path"
}

install_launchd_drift_audit_plist() {
  local template="$TEMPLATE_DIR/ai.hermes.launchd-drift-audit.plist.template"
  local plist_path="$LAUNCH_AGENTS_DIR/ai.hermes.launchd-drift-audit.plist"
  local script="$REPO_ROOT/scripts/audit-launchd-drift.sh"
  local log_dir="$HOME/.hermes/logs"
  local label="ai.hermes.launchd-drift-audit"

  if [ ! -f "$template" ]; then
    echo "ERROR: Missing template at $template"
    return 1
  fi

  if [ ! -f "$script" ]; then
    echo "ERROR: Missing script: $script"
    return 1
  fi

  chmod +x "$script" 2>/dev/null || true

  mkdir -p "$LAUNCH_AGENTS_DIR" "$log_dir"

  local tmp_plist
  tmp_plist="$(mktemp)"

  local slack_bot_token=""
  local slack_user_token=""
  local hermes_ops_channel=""

  slack_bot_token=$(bash -lic 'echo "${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${OPENCLAW_SLACK_BOT_TOKEN:-${HERMES_SLACK_BOT_TOKEN:-}}}"' 2>/dev/null || true)
  if [ -z "$slack_bot_token" ]; then
    slack_bot_token=$(bash -ic 'source ~/.bashrc 2>/dev/null; echo "${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${OPENCLAW_SLACK_BOT_TOKEN:-${HERMES_SLACK_BOT_TOKEN:-}}}"' 2>/dev/null || true)
  fi

  slack_user_token=$(bash -lic 'echo "$SLACK_USER_TOKEN"' 2>/dev/null || true)
  if [ -z "$slack_user_token" ]; then
    slack_user_token=$(bash -ic 'source ~/.bashrc 2>/dev/null; echo "$SLACK_USER_TOKEN"' 2>/dev/null || true)
  fi

  hermes_ops_channel=$(bash -lic 'echo "$HERMES_OPS_SLACK_CHANNEL"' 2>/dev/null || true)
  if [ -z "$hermes_ops_channel" ]; then
    hermes_ops_channel=$(bash -ic 'source ~/.bashrc 2>/dev/null; echo "$HERMES_OPS_SLACK_CHANNEL"' 2>/dev/null || true)
  fi

  # Fallback to current process env if profile sourcing is empty
  [ -z "$slack_bot_token" ] && slack_bot_token="${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${OPENCLAW_SLACK_BOT_TOKEN:-${HERMES_SLACK_BOT_TOKEN:-}}}"
  [ -z "$slack_user_token" ] && slack_user_token="${SLACK_USER_TOKEN:-}"
  [ -z "$hermes_ops_channel" ] && hermes_ops_channel="${HERMES_OPS_SLACK_CHANNEL:-}"

  # When a value is empty, leave the placeholder literal so the audit script's
  # soft-fail branch (empty HERMES_OPS_SLACK_CHANNEL or empty token) triggers
  # correctly — substituting __SET_BY_SETUP_LAUNCHD__ as a value would let it
  # bypass the empty check and post to Slack with bogus credentials.

  # NOTE: ai.hermes.launchd-drift-audit.plist.template uses __VAR__ placeholders
  # (not @VAR@) because at least one downstream plist validator rejected the
  # @ form even though plutil itself accepted it. Other templates in this repo
  # still use @VAR@; only this one diverges.
  sed \
    -e "s|__HOME__|$(escape_sed "$HOME")|g" \
    -e "s|__REPO_ROOT__|$(escape_sed "$REPO_ROOT")|g" \
    -e "s|__HERMES_OPS_SLACK_CHANNEL__|$(escape_sed "$hermes_ops_channel")|g" \
    -e "s|__SLACK_BOT_TOKEN__|$(escape_sed "$slack_bot_token")|g" \
    -e "s|__OPENCLAW_STAGING_SLACK_BOT_TOKEN__|$(escape_sed "$slack_bot_token")|g" \
    -e "s|__SLACK_USER_TOKEN__|$(escape_sed "$slack_user_token")|g" \
    "$template" > "$tmp_plist"

  plutil -lint "$tmp_plist" >/dev/null
  install -m 600 "$tmp_plist" "$plist_path"
  rm -f "$tmp_plist"

  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist_path"
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true

  echo "Installed launchd: $plist_path"
}

case "$action_script" in
  all)
    install_health_plist
    install_novel_plist
    install_health_guardian_plist
    ;;
  health)
    install_health_plist
    ;;
  health-guardian)
    install_health_guardian_plist
    ;;
  launchd-drift-audit)
    install_launchd_drift_audit_plist
    ;;
  lifecycle)
    echo "NOTE: 'lifecycle' mode is deprecated. Installing unified 'health' job instead."
    install_health_plist
    ;;
  novel)
    install_novel_plist
    ;;
  watchdog)
    echo "NOTE: 'watchdog' mode is deprecated. Installing unified 'health' job instead."
    install_health_plist
    ;;
  *)
    echo "ERROR: Unknown mode '$action_script'. Use all|health|health-guardian|novel|launchd-drift-audit"
    echo "  health               — unified AO health check (replaces lifecycle + watchdog)"
    echo "  health-guardian      — hourly watchdog-of-watchdogs guardian"
    echo "  novel                — daily novel aggregation"
    echo "  launchd-drift-audit  — nightly launchd drift audit with Slack alerts"
    echo "  all                  — health + novel + health-guardian"
    exit 1
    ;;
esac

echo "Log: $BASE_LOG_DIR"
echo "Check health status: launchctl print gui/$(id -u)/ai.agento.health"
echo "Check novel status: launchctl print gui/$(id -u)/ai.agento.novel-daily"
