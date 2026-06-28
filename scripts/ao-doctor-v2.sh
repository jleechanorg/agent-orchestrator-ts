#!/usr/bin/env bash
# ao-doctor-v2.sh — new unmonitored-signal checks (fragility audit 2026-06-10)
#
# Run standalone: bash scripts/ao-doctor-v2.sh
# Or: source it from ao-doctor.sh via `source "$SCRIPT_DIR/ao-doctor-v2.sh"`
#
# Adds checks for the 5 highest-ROI signals from the 2026-06-10 fragility
# audit. All checks use the pass/warn/fail helpers from ao-doctor.sh when
# sourced; when run standalone, prints [PASS]/[WARN]/[FAIL] prefixes.
#
# Reference: docs/doctor-sh-v2.md
#            wiki/concepts/AgentOrchestratorDoctorShV2.md

set -u

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes_prod}"
HERMES_STAGING_CONFIG="${HERMES_STAGING_CONFIG:-$HOME/.hermes/agent-orchestrator.yaml}"
HERMES_PROD_CONFIG="${HERMES_PROD_CONFIG:-$HOME/.hermes_prod/agent-orchestrator.yaml}"
AO_RUNNING_JSON="${HOME}/.agent-orchestrator/running.json"
AO_HEALTH_LOG="${AO_HEALTH_LOG:-$HOME/.openclaw/logs/ao-health.log}"
AO_HEALTH_GUARDIAN_LOG="${AO_HEALTH_GUARDIAN_LOG:-$HOME/.openclaw/logs/ao-health-guardian.log}"
AI_HERMES_WATCHDOG_LOG="${HERMES_WD_LOG:-$HOME/Library/Logs/hermes-watchdog.log}"
AO_HEALTH_LOG_MAX_AGE=600
AO_HEALTH_GUARDIAN_MAX_AGE=4200
AI_HERMES_WATCHDOG_MAX_AGE=900
AO_STALE_RUNNING_JSON_AGE=21600
AO_SESSION_HARD_CAP=20

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS %s\n' "$1"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf 'WARN %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL %s\n' "$1"; }

# Optional helper library gives reliable process matching and stale-running.json checks.
if [ -f "$SCRIPT_DIR/lib/ao-health-helpers.sh" ]; then
  # shellcheck source=./lib/ao-health-helpers.sh
  source "$SCRIPT_DIR/lib/ao-health-helpers.sh"
fi

running_json_pid() {
  local running_json="$1"
  if [ -f "$running_json" ]; then
    grep -o '"pid":[[:space:]]*[0-9]*' "$running_json" 2>/dev/null | \
      grep -o '[0-9]*' | head -1 || true
  fi
}

is_running_json_stale() {
  local running_json="$1"
  if declare -f should_clean_stale_running_json >/dev/null 2>&1; then
    if should_clean_stale_running_json "$running_json"; then
      return 0
    fi
    return 1
  fi

  local pid
  pid="$(running_json_pid "$running_json")"
  [ -n "$pid" ] || return 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

running_json_is_old() {
  local running_json="$1"
  local now_mtime age
  if [ ! -f "$running_json" ]; then
    return 1
  fi
  now_mtime=$(date +%s)
  age=$((now_mtime - $(stat -f %m "$running_json" 2>/dev/null || echo 0)))
  [ "$age" -gt "$AO_STALE_RUNNING_JSON_AGE" ]
}

project_list_from_config() {
  local cfg="$1"
  local projects=()
  if [ ! -f "$cfg" ]; then
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    local yaml_projects
    yaml_projects=$(python3 - "$cfg" <<'PY' 2>/dev/null || true
import yaml, sys
cfg = yaml.safe_load(open(sys.argv[1])) or {}
projects = cfg.get("projects") or {}
for key in projects:
    print(key)
PY
    )
    if [ -n "$yaml_projects" ]; then
      printf '%s\n' "$yaml_projects"
      return
    fi
  fi

  awk '
    /^projects:[[:space:]]*$/ { in_projects=1; next }
    in_projects && /^[^[:space:]]/ { in_projects=0 }
    in_projects && /^[[:space:]]+[a-zA-Z0-9_.-]+:[[:space:]]*(#.*)?$/ { gsub(/^[[:space:]]+/, "", $0); gsub(/:[[:space:]]*(#.*)?$/, "", $0); print $0 }
  ' "$cfg"
}

orchestrator_for_project_patterns() {
  local project
  for project in "$@"; do
    printf 'start[[:space:]]%s([[:space:]]|$)\n' "$project"
  done
}

# --- Check 1: staging config has scm: plugin: github for all projects ---
# Root cause of 2026-06-10 incident: staging config lost scm: / skepticModel /
# skepticPostComment silently — 16 PRs unevaluated fleet-wide.
check_scm_config_in_staging() {
  local cfg="$HERMES_STAGING_CONFIG"
  if [ ! -f "$cfg" ]; then
    warn "staging config not found at $cfg — skipping scm check"
    return
  fi
  if ! grep -q "scm:" "$cfg"; then
    fail "staging config $cfg has NO 'scm:' field — skeptic will silently return 0 for all PRs (see fragility 2026-06-10)"
    return
  fi
  # Count projects defined under the top-level `projects:` map only. The
  # project entries sit at exactly 2 spaces of indent (`  <name>:`). Nested
  # sub-keys like `tracker:`, `agentConfig:`, `scm-github:`, etc. also
  # match a 2-or-4-space YAML key pattern, so we anchor on the
  # `projects:` section header and count keys until the next
  # non-indented or shallower-indented key. This avoids false positives
  # from `reactions:`, `notifier-routing:`, plugin configs, etc.
  local project_count
  project_count=$(awk '
    BEGIN { in_projects=0; count=0 }
    /^projects:[[:space:]]*$/ { in_projects=1; next }
    in_projects && /^[^[:space:]]/ { in_projects=0 }
    in_projects && /^  [a-zA-Z][a-zA-Z0-9_-]*:[[:space:]]*(#.*)?$/ { count++ }
    END { print count+0 }
  ' "$cfg")
  local scm_count
  scm_count=$(grep -cE "^\s+scm:" "$cfg" 2>/dev/null || echo 0)
  if [ "$project_count" -gt 0 ] && [ "$scm_count" -lt "$project_count" ]; then
    warn "staging config $cfg has $scm_count 'scm:' entries but $project_count project(s) — some projects will be silently skipped"
  else
    pass "staging config $cfg has scm: for all $project_count project(s)"
  fi
}

check_defaults_agent_minimax_or_absent() {
  local cfg="$1"
  local label="$2"

  if [ ! -f "$cfg" ]; then
    warn "$label config missing at $cfg — skipping repo default-agent guard"
    return
  fi

  local agent_value
  agent_value=$(awk '
    /^defaults:/ { in_defaults=1; next }
    in_defaults && /^[^[:space:]]/ { in_defaults=0 }
    in_defaults && /^[[:space:]]+agent:[[:space:]]*/ {
      sub(/^[[:space:]]*agent:[[:space:]]*/, "", $0)
      sub(/#.*/, "", $0)
      gsub(/[[:space:]]+$/, "", $0)
      print $0
      exit
    }
  ' "$cfg")

  if [ -z "$agent_value" ]; then
    pass "$label uses global default for defaults.agent (no explicit pin)"
    return
  fi

  if [ "$agent_value" = "minimax" ]; then
    pass "$label defaults.agent is explicitly set to minimax"
  else
    fail "$label defaults.agent is '$agent_value' in $cfg; remove repo-level pin or set to minimax"
  fi
}

check_defaults_agent_config_model_absent_or_global() {
  local cfg="$1"
  local label="$2"

  if [ ! -f "$cfg" ]; then
    warn "$label config missing at $cfg — skipping repo default-model guard"
    return
  fi

  local model_value=""
  if command -v python3 >/dev/null 2>&1; then
    model_value="$(python3 - "$cfg" <<'PY' 2>/dev/null || true
import sys

try:
    import yaml
except Exception:
    raise SystemExit(0)

cfg = yaml.safe_load(open(sys.argv[1])) or {}
defaults = cfg.get("defaults") or {}
agent_config = defaults.get("agentConfig") or {}
model = agent_config.get("model")
if model is None:
    print("")
else:
    print(str(model).strip())
PY
)"
  fi

  if [ -z "$model_value" ]; then
    model_value="$(awk '
      /^defaults:/ { in_defaults=1; in_agent_config=0; next }
      in_defaults && /^[^[:space:]]/ { in_defaults=0; in_agent_config=0 }
      in_defaults && /^  agentConfig:/ { in_agent_config=1; next }
      in_defaults && in_agent_config && /^[[:space:]]{6}model:[[:space:]]*/ {
        sub(/^[[:space:]]*model:[[:space:]]*/, "", $0)
        sub(/#.*/, "", $0)
        gsub(/[[:space:]]+$/, "", $0)
        print $0
        exit
      }
      in_defaults && in_agent_config && /^  [^[:space:]]/ { in_agent_config=0 }
      in_defaults && in_agent_config && /^ [^[:space:]]/ { in_agent_config=0 }
    ' "$cfg")"
  fi

  if [ -z "$model_value" ]; then
    pass "$label does not override defaults.agentConfig.model (global model default in use)"
  else
    fail "$label has defaults.agentConfig.model set to '$model_value'; remove it to force global default model behavior"
  fi
}

# --- Check 2: skeptic-cron 24h age filter is present in source ---
# bd-rgk0 root cause: filter was BEFORE trigger check, silently dropping
# fresh /skeptic comments. The fix (PR #661) moved it AFTER.
check_skeptic_age_filter_order() {
  # Source path was moved from packages/cli/src/lib/ → packages/core/src/
  # during the 2026 core refactor; check both locations.
  local src=""
  for cand in \
    "$REPO_ROOT/packages/core/src/skeptic-cron-local.ts" \
    "$REPO_ROOT/packages/cli/src/lib/skeptic-cron-local.ts" \
    "$REPO_ROOT/packages/core/src/skeptic-cron.ts"; do
    if [ -f "$cand" ]; then
      src="$cand"
      break
    fi
  done
  if [ -z "$src" ]; then
    warn "skeptic-cron source not found under packages/{core,cli}/src — skipping age-filter check"
    return
  fi
  if ! grep -qE "updatedAt|updated_at" "$src"; then
    fail "skeptic-cron source has no updatedAt/updated_at check — bd-rgk0 regression risk ($src)"
    return
  fi
  # bd-rgk0: verify the trigger check is encountered BEFORE the age filter
  # at CODE level (not comment level). Find the first non-comment occurrence
  # of each pattern, where "comment" is a line whose first non-whitespace
  # character is `*` (JSDoc continuation), `//` (single-line), or `#`.
  local trigger_line filter_line
  trigger_line=$(awk '
    /^[ \t]*\/\// { next }
    /^[ \t]*\*/ { next }
    /^[ \t]*\/\*/ { next }
    /trigger|isSkepticTrigger|isTrigger|has_trigger/ { print NR; exit }
  ' "$src")
  filter_line=$(awk '
    /^[ \t]*\/\// { next }
    /^[ \t]*\*/ { next }
    /^[ \t]*\/\*/ { next }
    /updatedAt|updated_at/ { print NR; exit }
  ' "$src")
  if [ -n "$trigger_line" ] && [ -n "$filter_line" ] \
      && [ "$trigger_line" -lt "$filter_line" ]; then
    pass "skeptic-cron age filter is AFTER trigger check at code level (bd-rgk0 guard): trigger@L${trigger_line}, filter@L${filter_line} ($src)"
  elif [ -n "$trigger_line" ] && [ -n "$filter_line" ]; then
    fail "skeptic-cron age filter is BEFORE trigger check at code level — bd-rgk0 regression! trigger@L${trigger_line}, filter@L${filter_line} ($src)"
    return
  else
    # We can find one but not the other. Fail-safe: warn so the operator
    # can manually verify, but don't blow up the doctor.
    warn "skeptic-cron order could not be verified at code level: trigger_line=${trigger_line:-?}, filter_line=${filter_line:-?} ($src)"
  fi
}

# --- Check 3: AO_BOT_GH_TOKEN is not a redacted placeholder ---
# Root cause: stale exported redacted tokens cause 401s that workers
# misclassify as transient.
check_gh_token_not_redacted() {
  local token="${AO_BOT_GH_TOKEN:-${GH_TOKEN:-}}"
  if [ -z "$token" ]; then
    warn "AO_BOT_GH_TOKEN / GH_TOKEN not set in env — cannot verify; check 401s manually"
    return
  fi
  case "$token" in
    "__OPENCLAW_REDACTED__"|"__REDACTED__"|"")
      fail "AO_BOT_GH_TOKEN is a redacted placeholder ($token) — workers will get 401"
      ;;
    *)
      pass "AO_BOT_GH_TOKEN is a real token (length=${#token}, prefix=${token:0:4}...)"
      ;;
  esac
}

# --- Check 3b: MiniMax API key is real ---
# Root cause: stale/invalid auth headers produce 401s for AO workers while other
# checks still pass.
check_minimax_key_not_redacted() {
  local token="${MINIMAX_API_KEY:-${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}}"
  if [ -z "$token" ]; then
    warn "MINIMAX_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN not set — AO minimax workers may get 401s"
    return
  fi
  case "$token" in
    "__OPENCLAW_REDACTED__"|"__REDACTED__"|"REDACTED"|"")
      fail "MiniMax auth token is a redacted placeholder — minimax worker requests will fail with 401"
      ;;
    *)
      pass "MiniMax auth token is present and non-placeholder (prefix=${token:0:4}...)"
      ;;
  esac
}

# --- Check 4: dist loaded in memory vs dist on disk ---
# Root cause: ao dist deploy workflow keeps a symlink at ${AO_BIN_PATH:-/usr/local/bin/ao}
# pointing to the repo dist; if process holds old dist in memory, PR-merged ≠ fix-deployed.
# Use $AO_BIN_PATH or `which ao` to find the symlink, never a hardcoded user path.
check_dist_md5_match() {
  local cli_bin="${AO_BIN_PATH:-$(command -v ao 2>/dev/null || true)}"
  local source_dist="$REPO_ROOT/packages/cli/dist/index.js"
  if [ -z "$cli_bin" ] || { [ ! -L "$cli_bin" ] && [ ! -f "$cli_bin" ]; }; then
    warn "no ao binary found (set \$AO_BIN_PATH or ensure 'ao' is on PATH) — skipping dist match check"
    return
  fi
  local resolved
  resolved=$(readlink "$cli_bin" 2>/dev/null || echo "$cli_bin")
  if grep -q "node_modules/@jleechanorg/ao-cli/dist/index.js" "$resolved" 2>/dev/null; then
    local wrapper_dir
    wrapper_dir=$(dirname "$resolved")
    local extracted_path
    extracted_path=$(grep -oE '"[^"]*@jleechanorg/ao-cli/dist/index.js"' "$resolved" | head -1 | tr -d '"')
    if [ -n "$extracted_path" ]; then
      extracted_path="${extracted_path//\$basedir/$wrapper_dir}"
      resolved="$extracted_path"
    fi
  fi
  if [ ! -f "$source_dist" ]; then
    warn "source dist not built at $source_dist — run 'pnpm build' first"
    return
  fi
  local src_md5 bin_md5
  src_md5=$(md5 -q "$source_dist" 2>/dev/null || md5sum "$source_dist" 2>/dev/null | awk '{print $1}')
  if [ -f "$resolved" ]; then
    bin_md5=$(md5 -q "$resolved" 2>/dev/null || md5sum "$resolved" 2>/dev/null | awk '{print $1}')
  fi
  if [ -n "$src_md5" ] && [ -n "$bin_md5" ] && [ "$src_md5" != "$bin_md5" ]; then
    warn "dist md5 mismatch: source=$src_md5 binary=$bin_md5 — workers may be running stale code (PR-merged ≠ fix-deployed)"
  elif [ -n "$src_md5" ] && [ -n "$bin_md5" ]; then
    pass "dist md5 matches between source and binary ($src_md5)"
  else
    warn "could not compute md5 for source or binary; skipping dist match check"
  fi
}

# --- Check 5: running.json existence after reboot ---
# Root cause: ao start writes running.json; ao spawn needs it. Reboot
# without re-running ao start → running.json missing → ao spawn fails.
check_running_json_present() {
  local running="$AO_RUNNING_JSON"
  local pid
  if [ ! -f "$running" ]; then
    fail "running.json missing at $running — 'ao spawn' will fail. Fix: run 'ao start' or 'setup-launchd.sh lifecycle'"
    return
  fi
  pass "running.json present at $running"
  if is_running_json_stale "$running"; then
    fail "running.json appears stale: pid=$(running_json_pid "$running") is not alive"
    return
  fi
  if running_json_is_old "$running"; then
    warn "running.json is old (mtime > ${AO_STALE_RUNNING_JSON_AGE}s) — possible daemon drift"
  fi
  if pid="$(running_json_pid "$running")"; then
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      fail "running.json pid $pid is dead"
      return
    fi
    if [ -n "$pid" ]; then
      local cmd ao_match
      cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      if [ -z "$cmd" ]; then
        warn "running.json pid $pid exists but command line is unavailable"
        return
      fi
      ao_match="${AO_CLI_PATH:-$(command -v ao 2>/dev/null || true)}"
      if [ -n "$ao_match" ] && declare -f command_matches_ao_binary >/dev/null 2>&1; then
        if ! command_matches_ao_binary "$cmd" "$ao_match"; then
          fail "running.json pid $pid is not this repo's AO process (cmd: $cmd)"
          return
        fi
      fi
      if ! echo "$cmd" | grep -qE "[[:space:]]start[[:space:]]"; then
        warn "running.json pid $pid does not look like an 'ao start' orchestrator command"
      else
        pass "running.json pid $pid is alive and tied to AO start process"
      fi
    fi
  fi
}

# --- Check 5: AO session pressure and spawn backlog ---
# Root cause: last week saw repeated "spawning" saturation and 5h backfill
# cap alarms while spawn pressure rose past operational guardrails.
check_ao_session_pressure() {
  local session_output total_sessions spawning_count
  local line sid state spawning_ids=0
  local output_count=0

  if ! command -v ao >/dev/null 2>&1; then
    warn "ao CLI not available — cannot run AO session pressure check"
    return
  fi

  if ! session_output="$(ao session ls 2>/dev/null)"; then
    warn "ao session ls failed (possibly hung/spawned child dead) — using tmux sessions as a fallback"
    if command -v tmux >/dev/null 2>&1; then
      output_count="$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')"
      [ -z "$output_count" ] && output_count=0
      if [ "$output_count" -ge "$AO_SESSION_HARD_CAP" ]; then
        fail "tmux session count (${output_count}) is at/above hard AO session cap (${AO_SESSION_HARD_CAP})"
      elif [ "$output_count" -gt 0 ]; then
        pass "tmux session count is ${output_count} (ao session ls fallback)"
      else
        warn "tmux session count unavailable or zero while ao session ls failed"
      fi
    else
      warn "tmux not available for fallback when ao session ls fails"
    fi
    return
  fi

  total_sessions=0
  spawning_count=0

  while IFS= read -r line; do
    if printf '%s\n' "$line" | grep -qE '^[[:space:]]*[A-Za-z0-9._-]+-[0-9]+[[:space:]]+\([^)]*\)[[:space:]]+\[[^]]+\]'; then
      sid="${line%% *}"
      state="$(printf '%s' "$line" | sed -E 's/.*\[(.+)\]$/\1/')"
      total_sessions=$((total_sessions + 1))
      if [[ "$state" == *"spawning"* ]]; then
        spawning_count=$((spawning_count + 1))
        spawning_ids="${spawning_ids} $sid"
      fi
    fi
  done <<< "$session_output"

  if [ "$total_sessions" -eq 0 ]; then
    warn "no AO sessions detected in ao session ls output"
    return
  fi

  if [ "$total_sessions" -ge "$AO_SESSION_HARD_CAP" ]; then
    fail "AO session pressure is at/above hard cap: total active sessions=$total_sessions (cap=${AO_SESSION_HARD_CAP})"
  elif [ "$total_sessions" -gt 14 ]; then
    warn "AO session pressure is high: total active sessions=$total_sessions"
  else
    pass "AO session pressure is healthy: total active sessions=$total_sessions"
  fi

  if [ "$spawning_count" -gt 0 ]; then
    if [ "$spawning_count" -ge 3 ]; then
      warn "AO has ${spawning_count} spawning session(s) — backlog risk: ${spawning_ids}"
    else
      pass "AO spawning sessions count is low: ${spawning_count}"
    fi
  fi
}
# The orchestrator must be actively running 'ao start <project>' and lifecycle
# workers must exist; if the queue is up but workers are not, we're in polling
# drift and worker spawn requests will fail/hang.
check_orchestrator_polling_health() {
  local cfg_projects project_count worker_count
  cfg_projects="$(project_list_from_config "$HERMES_STAGING_CONFIG")"
  if [ -z "$cfg_projects" ]; then
    warn "no projects found in $HERMES_STAGING_CONFIG; skipping orchestrator poll-health check"
    return
  fi

  project_count=$(printf '%s\n' "$cfg_projects" | awk 'NF' | wc -l | tr -d ' ')
  [ "$project_count" -gt 0 ] || { warn "project list is empty; skipping orchestrator poll-health check"; return; }

  local found_orchestrator=0
  local ao_binary="${AO_CLI_PATH:-$(command -v ao 2>/dev/null || true)}"
  for project in $cfg_projects; do
    local pids
    pids="$(pgrep -f "start[[:space:]]${project}([[:space:]]|$)" 2>/dev/null || true)"
    for pid in $pids; do
      local cmd
      cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      if [ -z "$cmd" ]; then
        continue
      fi
      if [ -n "$ao_binary" ] && declare -f command_matches_ao_binary >/dev/null 2>&1; then
        if command_matches_ao_binary "$cmd" "$ao_binary"; then
          found_orchestrator=1
          break 2
        fi
      else
        found_orchestrator=1
        break 2
      fi
    done
  done

  if [ "$found_orchestrator" -eq 0 ]; then
    fail "no live AO orchestrator ('ao start <project>') found for configured projects"
  else
    pass "AO orchestrator is actively running for configured projects"
  fi

  worker_count=$(pgrep -f "lifecycle-worker" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${worker_count:-0}" -eq 0 ]; then
    if [ "$found_orchestrator" -eq 1 ]; then
      pass "lifecycle-worker polling is running in-process inside the AO orchestrator"
    else
      fail "lifecycle polling appears inactive: no lifecycle-worker processes found"
    fi
    return
  fi
  if [ "$worker_count" -lt "$project_count" ]; then
    warn "lifecycle-worker count $worker_count is below configured project count $project_count"
    return
  fi
  pass "lifecycle-worker polling is running ($worker_count process(es))"
}

check_service_log_fresh() {
  local label="$1"
  local log_path="$2"
  local max_age="$3"
  if [ ! -f "$log_path" ]; then
    local filename
    filename=$(basename "$log_path")
    local alt_path="$HOME/.hermes/logs/$filename"
    if [ -f "$alt_path" ]; then
      log_path="$alt_path"
    else
      fail "$label log not present at $log_path (service may be inert)"
      return
    fi
  fi
  local now_ts log_mtime age
  now_ts=$(date +%s)
  log_mtime=$(stat -f %m "$log_path" 2>/dev/null || echo 0)
  age=$((now_ts - log_mtime))
  if [ "$age" -gt "$max_age" ]; then
    fail "$label has stale log activity (age=${age}s, max=${max_age}s): $log_path"
    return
  fi
  pass "$label is reporting within freshness window (${age}s <= ${max_age}s)"
}

# --- Check 6: Tier 1 + Tier 2 + cross-watchdog all present ---
check_watchdog_chain() {
  local missing=0
  for label in ai.agento.health ai.agento.health-guardian ai.hermes.watchdog; do
    local plist_path="$HOME/Library/LaunchAgents/${label}.plist"
    if [ ! -f "$plist_path" ]; then
      warn "launchd plist missing on disk: $plist_path"
    fi
    if ! launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -q "type = LaunchAgent"; then
      warn "watchdog plist $label not registered with launchd"
      missing=$((missing + 1))
    else
      pass "watchdog plist $label is registered"
    fi
  done
  if [ "$missing" -gt 0 ]; then
    warn "watchdog chain has $missing missing link(s) — fragility window unbounded"
  fi
  check_service_log_fresh "ai.agento.health" "$AO_HEALTH_LOG" "$AO_HEALTH_LOG_MAX_AGE"
  check_service_log_fresh "ai.agento.health-guardian" "$AO_HEALTH_GUARDIAN_LOG" "$AO_HEALTH_GUARDIAN_MAX_AGE"
  check_service_log_fresh "ai.hermes.watchdog" "$AI_HERMES_WATCHDOG_LOG" "$AI_HERMES_WATCHDOG_MAX_AGE"
}

# --- Check 7: ai.agento.health-guardian log presence and freshness ---
# Root cause: ai.agento.health-guardian plist may be loaded but its
# StandardOutPath / StandardErrorPath point to a dir that does not exist
# (e.g. /Users/jleechan/.openclaw/logs) — launchd silently drops output
# and the watchdog becomes inert.
check_health_guardian_log_present() {
  local log="$HOME/.openclaw/logs/ao-health-guardian.log"
  local err_log="$HOME/.openclaw/logs/ao-health-guardian.err.log"
  if [ ! -d "$(dirname "$log")" ]; then
    fail "log directory $(dirname "$log") missing — ai.agento.health-guardian will be inert"
    return
  fi
  if [ ! -f "$log" ]; then
    fail "ai.agento.health-guardian log missing at $log — service may be inert"
    return
  fi
  # Freshness: log should have been written within the last 30 minutes
  local mtime now_diff
  if [[ "$OSTYPE" == "darwin"* ]]; then
    mtime=$(stat -f %m "$log" 2>/dev/null || echo 0)
  else
    mtime=$(stat -c %Y "$log" 2>/dev/null || echo 0)
  fi
  now_diff=$(( $(date +%s) - mtime ))
  if [ "$now_diff" -gt 1800 ]; then
    warn "ai.agento.health-guardian log is stale (${now_diff}s old) at $log"
  else
    pass "ai.agento.health-guardian log is fresh (${now_diff}s old) at $log"
  fi
  if [ -f "$err_log" ]; then
    local err_size
    err_size=$(wc -c < "$err_log" 2>/dev/null || echo 0)
    if [ "$err_size" -gt 0 ]; then
      warn "ai.agento.health-guardian error log is non-empty (${err_size} bytes) at $err_log"
    fi
  fi
}

# --- Check 8: launchd plist log paths resolve to existing directories ---
# Root cause: ai.hermes.* plists sometimes reference /Users/jleechan/.hermes/logs
# while other agents reference /Users/jleechan/.openclaw/logs — when the
# referenced dir does not exist launchd silently drops stdout/stderr.
check_log_path_consistency() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local missing_dir=0
  local plist
  for plist in "$plist_dir"/ai.hermes.*.plist "$plist_dir"/ai.agento.*.plist; do
    [ -f "$plist" ] || continue
    local label log_dir
    label=$(basename "$plist" .plist)
    # Find StandardOutPath / StandardErrorPath entries
    log_dir=$(grep -A1 -E 'Standard(Out|Error)Path' "$plist" 2>/dev/null \
              | grep -E '<string>' \
              | sed -E 's:.*<string>(.*)</string>.*:\1:' \
              | xargs -I{} dirname {} 2>/dev/null \
              | sort -u)
    for d in $log_dir; do
      if [ -n "$d" ] && [ ! -d "$d" ]; then
        fail "plist $label references missing log dir $d (StandardOutPath/StandardErrorPath)"
        missing_dir=$((missing_dir + 1))
      fi
    done
  done
  if [ "$missing_dir" -eq 0 ]; then
    pass "all launchd plist log paths resolve to existing directories"
  fi
}

# --- Check 9: ao binary pnpm wrapper resolves to source tree ---
# Root cause: when `ao` resolves to a pnpm shell wrapper that itself
# invokes a symlinked dist under /Users/jleechan/Library/pnpm/..., the
# dist md5 match check above will see a mismatch if the wrapper picks
# the wrong target. We verify the symlink chain ends inside $REPO_ROOT.
check_pnpm_wrapper_resolution() {
  local cli_bin="${AO_BIN_PATH:-$(command -v ao 2>/dev/null || true)}"
  if [ -z "$cli_bin" ]; then
    warn "no ao binary found (set \$AO_BIN_PATH or ensure 'ao' is on PATH) — skipping pnpm resolution check"
    return
  fi
  # Walk symlinks up to 10 levels deep. Relative `readlink` output must
  # be resolved against the directory of the symlink we just dereferenced
  # — NOT the cwd or the relative text itself. Capture `dirname` BEFORE
  # reassigning `target` so the link's own directory anchors resolution
  # (Greptile P1: relative symlinks were resolved against the doctor
  # process cwd, false-warning on valid /usr/local/bin/ao -> ../pnpm/ao).
  local target="$cli_bin" i=0
  while [ -L "$target" ] && [ "$i" -lt 10 ]; do
    local link_dir next
    link_dir=$(dirname "$target")
    next=$(readlink "$target")
    case "$next" in
      /*) target="$next" ;;
      *)  target="$link_dir/$next" ;;
    esac
    i=$((i + 1))
  done
  if [ -f "$target" ]; then
    # Normalize via cd+pwd so path-boundary check isn't fooled by
    # `..` segments. Use PREFIX match (`== $repo || == $repo/*`) instead of
    # substring match, otherwise a sibling directory like
    # `/Users/me/agent-orchestrator-old/bin/ao` would match
    # `*$REPO_ROOT*` and false-PASS (Greptile P1 followup: Path boundary
    # missing).
    local normalized_target normalized_repo
    normalized_target="$(cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")"
    normalized_repo="$(cd "$REPO_ROOT" 2>/dev/null && pwd)"
    if [[ -n "$normalized_repo" && ( "$normalized_target" == "$normalized_repo" || "$normalized_target" == "$normalized_repo"/* ) ]]; then
      pass "ao binary resolves to source tree ($normalized_target)"
    else
      warn "ao binary does NOT resolve to source tree — resolved to $normalized_target (REPO_ROOT=$REPO_ROOT). Workers may run stale code"
    fi
  else
    warn "could not resolve ao binary symlink chain (started at $cli_bin) — skipping"
  fi
}

# --- Check 10: main-repo guard bypass is configured ---
# Root cause: ao start refuses to run on the agent-orchestrator repo
# itself (the main repo). If the health watchdog's ANCHOR_PROJECT env
# or config is not set to a non-main project, the watchdog will crash
# on every iteration and never bring the orchestrator back online.
check_main_repo_guard_bypass() {
  local cfg="$HERMES_STAGING_CONFIG"
  if [ ! -f "$cfg" ]; then
    warn "staging config not found at $cfg — skipping main-repo guard check"
    return
  fi
  # The actual signal that the STARTUP PATH honors:
  #   `scripts/ao-health.sh:130` computes `ANCHOR_PROJECT="$(echo "$PROJECTS"
  #   | awk '{print $1}')"` — the first project name in the staging config's
  #   `projects:` map. That name is then passed to `ao start $ANCHOR_PROJECT`
  #   on line 167. The start command resolves that name to a PATH (via the
  #   project's `path:` field or config-dir default) and the main-repo guard
  #   at packages/cli/src/commands/start.ts:745 rejects when the resolved
  #   path equals or is under the main repo.
  #
  # Heuristic only: the project's NAME may not match "agent-orchestrator"
  # while its PATH still points at the main repo (Greptile P1 round-8:
  # Project path unchecked). Use the project's `path:` field when present,
  # and fall back to comparing the project NAME to the repo basename.
  local first_project first_path
  first_project=$(awk '
    BEGIN { in_projects=0 }
    /^projects:[[:space:]]*$/ { in_projects=1; next }
    in_projects && /^[^[:space:]]/ { in_projects=0 }
    in_projects && /^  [a-zA-Z][a-zA-Z0-9_-]*:[[:space:]]*(#.*)?$/ {
      match($0, /[a-zA-Z][a-zA-Z0-9_-]*/)
      if (RSTART > 0) {
        print substr($0, RSTART, RLENGTH)
        exit
      }
    }
  ' "$cfg")
  if [ -z "$first_project" ]; then
    warn "no projects configured in $cfg — health watchdog has nothing to launch"
    return
  fi
  # Extract the first project's `path:` field, if present. Strip
  # surrounding quotes (`path: "/foo"` is valid YAML) so the normalization
  # step below resolves to a real directory (Greptile P1 round-9: Quoted
  # paths pass incorrectly).
  first_path=$(awk -v proj="$first_project" '
    BEGIN { in_proj=0; depth=0 }
    # Match the project key at exactly 2-space indent
    $0 ~ "^  " proj ":[[:space:]]*(#.*)?$" { in_proj=1; next }
    in_proj && /^[ \t]*path:[[:space:]]*/ {
      match($0, /path:[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+)/)
      if (RSTART > 0) {
        s = substr($0, RSTART, RLENGTH)
        sub(/^path:[[:space:]]+/, "", s)
        # Strip surrounding quotes
        sub(/^["'"'"']/, "", s)
        sub(/["'"'"']$/, "", s)
        print s
        exit
      }
    }
    # Leave the project block when we hit a shallower key
    in_proj && /^[^[:space:]]/ { in_proj=0 }
  ' "$cfg")
  local main_repo_basename
  main_repo_basename=$(basename "$REPO_ROOT")
  # If the project has an explicit path, use it; otherwise fall back to name.
  if [ -n "$first_path" ]; then
    # Resolve relative path against the config dir
    case "$first_path" in
      /*) ;;
      *)  first_path="$(cd "$(dirname "$cfg")" && pwd)/$first_path" ;;
    esac
    # Normalize via cd+pwd
    if [ -d "$first_path" ]; then
      first_path="$(cd "$first_path" && pwd)"
    fi
    local normalized_main
    normalized_main="$(cd "$REPO_ROOT" 2>/dev/null && pwd)"
    if [[ "$first_path" == "$normalized_main" || "$first_path" == "$normalized_main"/* ]]; then
      warn "first project '$first_project' path '$first_path' is under main repo — watchdog will crash on start"
    else
      pass "main-repo guard bypass OK: project '$first_project' path '$first_path' is outside main repo"
    fi
  elif [ "$first_project" = "agent-orchestrator" ] || [ "$first_project" = "$main_repo_basename" ]; then
    warn "first project in $cfg is '$first_project' — likely the main repo. health watchdog will crash on start. Add a non-main project as the FIRST entry in projects: or set --allow-main-repo in the plist."
  else
    pass "main-repo guard bypass OK: anchor project '$first_project' is not the main repo (no explicit path set; uses config-dir default)"
  fi
}

# --- Check 11: ai.hermes.staging launchd agent is enabled ---
# Root cause: staging agent can be silently disabled via `launchctl disable`
# after an auth/cert error. The plist is loaded but launchd refuses to
# start the process. Gate slips past `launchctl print` checks.
check_hermes_staging_launchd_state() {
  local label="ai.hermes.staging"
  if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    warn "launchd label $label not registered — skipping enable check"
    return
  fi
  # launchctl print-disabled shows disabled agents. Output uses an
  # INDENTED `"label" => true` form (e.g. `  "ai.hermes.staging" => true`),
  # so anchor on the quoted arrow form rather than a leading non-space char
  # (Greptile P1: previous `^[^[:space:]].*$label` regex silently missed the
  # indented lines and reported a disabled agent as enabled).
  local disabled_state
  disabled_state=$(launchctl print-disabled "gui/$(id -u)" 2>/dev/null \
    | grep -E "^[[:space:]]*\"?$label\"?[[:space:]]*=>[[:space:]]*true" \
    || true)
  if [ -n "$disabled_state" ]; then
    fail "launchd label $label is DISABLED — re-enable with: launchctl enable gui/\$(id -u)/$label"
    return
  fi
  # Check the run state — should not be "not running" indefinitely if no LastExit
  local state_line
  state_line=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -E "^\s*state\s*=" | head -1 || true)
  if [ -n "$state_line" ]; then
    pass "launchd label $label is enabled (${state_line##*= })"
  else
    warn "could not read launchd state for $label"
  fi
}

# --- Check 12: ai.hermes.watchdog plist exists on disk ---
# Root cause: ai.hermes.watchdog plist may be loaded into launchd but the
# on-disk file is missing — making it impossible to inspect or modify.
check_hermes_watchdog_plist_on_disk() {
  local plist="$HOME/Library/LaunchAgents/ai.hermes.watchdog.plist"
  if [ ! -f "$plist" ]; then
    fail "ai.hermes.watchdog plist missing on disk at $plist — watchdog chain gap"
    return
  fi
  if ! plutil -lint "$plist" >/dev/null 2>&1; then
    fail "ai.hermes.watchdog plist at $plist fails plutil lint — syntax error"
    return
  fi
  pass "ai.hermes.watchdog plist present and valid at $plist"
}

# --- Check 13: staging-gateway listening port responds ---
# Root cause: ai.hermes.staging may be enabled but its gateway component
# may crash on Slack MCP init, leaving the API port unbound. Workers
# then fail health checks silently.
check_staging_gateway_health() {
  # Use the canonical staging config (HERMES_STAGING_CONFIG, defaults to
  # ~/.hermes/agent-orchestrator.yaml) — the rest of the doctor reads from
  # it, so the gateway port check must too. Previously this hardcoded
  # ~/.hermes/config.staging.yaml which would either miss the configured
  # port (false 8644 probe) or skip the YAML parse entirely (Greptile P1).
  # Scope the port lookup to a `staging:` / `gateway:` / `staging-gateway:`
  # block so an unrelated plugin/project `port:` setting doesn't override
  # it (Greptile P1 followup: Port lookup unscoped).
  local staging_cfg="$HERMES_STAGING_CONFIG"
  local port=8644  # default staging port per ~/.hermes/agent-orchestrator.yaml
  if [ -f "$staging_cfg" ]; then
    port=$(awk '
      BEGIN { in_scope=0 }
      # Enter the staging / gateway / staging-gateway block
      /^[ \t]*(staging|gateway|staging-gateway):[ \t]*$/ { in_scope=1; next }
      # Or inline flow: staging: { port: 8644 } — DO NOT clear in_scope on
      # the SAME line that set it (Greptile P1 followup: Inline port skipped).
      /^[ \t]*(staging|gateway|staging-gateway):[ \t]*\{/ { in_scope=1 }
      # Leave the block on a shallower-indented key — but NOT the inline
      # flow opener line (already handled above).
      in_scope && /^[^[:space:]]/ && $0 !~ /^[ \t]*(staging|gateway|staging-gateway):[ \t]*\{/ { in_scope=0 }
      # Read port: / listen_port: inside the scope
      in_scope && /port:[ \t]*[0-9]+/ {
        line = $0
        if (match(line, /port:[ \t]*[0-9]+/)) {
          s = substr(line, RSTART, RLENGTH)
          sub(/^port:[ \t]*/, "", s)
          print s
          exit
        }
      }
      in_scope && /listen_port:[ \t]*[0-9]+/ {
        line = $0
        if (match(line, /listen_port:[ \t]*[0-9]+/)) {
          s = substr(line, RSTART, RLENGTH)
          sub(/^listen_port:[ \t]*/, "", s)
          print s
          exit
        }
      }
    ' "$staging_cfg")
    port="${port:-8644}"
  fi
  # Probe the port via lsof
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    pass "staging-gateway port $port is listening"
  else
    warn "staging-gateway port $port is NOT listening — gateway may have crashed (check ~/.hermes/logs/staging-gateway.err.log)"
  fi
}

# --- Check 14: defaults.agent references resolve to a registered plugin ---
# Root cause: agent-orchestrator.yaml may set defaults.agent: minimax
# (or wafer / claude) but the plugin package may not be installed.
# Workers then fail at spawn time with cryptic "plugin not found" errors.
check_default_agent_undefined_refs() {
  local cfg="$HERMES_STAGING_CONFIG"
  if [ ! -f "$cfg" ]; then
    warn "staging config not found at $cfg — skipping default-agent check"
    return
  fi
  local default_agent
  # Parse defaults.agent in two forms:
  #   (a) block style:
  #         defaults:
  #           agent: minimax
  #   (b) inline YAML flow style:
  #         defaults: {agent: minimax}
  # Earlier versions only matched (a), leaving `default_agent` empty for
  # inline configs and silently skipping the missing-plugin failure the
  # check was added to catch (Greptile P2: Inline Defaults Are Skipped).
  # Also reset `in_defaults` when we hit a new top-level key, otherwise a
  # later `agent:` under a different section leaks in (CodeRabbit prompt).
  # Accept QUOTED agent names (`agent: "minimax"` / `agent: 'minimax'`)
  # which are valid YAML — the bare `[a-zA-Z0-9_-]+` regex would skip them
  # and falsely warn "no defaults.agent configured" (Greptile P1 followup:
  # Quoted agents skip checks).
  default_agent=$(awk '
    BEGIN { in_defaults=0 }
    # Multi-line defaults block opener
    /^[ \t]*defaults:[ \t]*$/ { in_defaults=1; next }
    # Inline flow opener: defaults: {agent: ...}
    /^[ \t]*defaults:[ \t]*\{/ {
      in_defaults=1
      line = $0
      # Match `agent:` followed by either a quoted string ("minimax" or
      # '\''minimax'\'') OR a bare word ([a-zA-Z0-9_-]+). The full value
      # must be captured so the trailing `sub()` can strip `}` cleanly.
      if (match(line, /agent:[ \t]*(["'"'"'][a-zA-Z0-9_-]+["'"'"']|[a-zA-Z0-9_-]+)/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*agent:[ \t]+/, "", s)
        sub(/[ \t,}]*$/, "", s)
        # Strip surrounding quotes if present (idempotent on unquoted)
        sub(/^["'"'"']/, "", s)
        sub(/["'"'"']$/, "", s)
        print s
        exit
      }
      next
    }
    # Reset when leaving the defaults block
    in_defaults && /^[^[:space:]]/ { in_defaults=0 }
    # Block-style `agent:` line under defaults — accept quoted or unquoted
    in_defaults && /^[ \t]*agent:[ \t]*(["'"'"']|[a-zA-Z0-9_-])/ {
      # POSIX awk: use match()+substr() (gawk array extension is not portable)
      match($0, /[ \t][ \t]*agent:[ \t]*(["'"'"'][a-zA-Z0-9_-]+["'"'"']|[a-zA-Z0-9_-]+)/)
      if (RSTART > 0) {
        s = substr($0, RSTART, RLENGTH)
        sub(/.*agent:[ \t]+/, "", s)
        sub(/[ \t#]*$/, "", s)
        # Strip surrounding quotes if present (idempotent on unquoted)
        sub(/^["'"'"']/, "", s)
        sub(/["'"'"']$/, "", s)
        print s
        exit
      }
    }
  ' "$cfg")
  if [ -z "$default_agent" ]; then
    warn "no defaults.agent configured in $cfg — skipping plugin resolution check"
    return
  fi
  local plugin_pkg
  case "$default_agent" in
    claude|claude-code) plugin_pkg="@jleechanorg/ao-plugin-agent-claude-code" ;;
    minimax)            plugin_pkg="@jleechanorg/ao-plugin-agent-minimax" ;;
    wafer)              plugin_pkg="@jleechanorg/ao-plugin-agent-wafer" ;;
    codex)              plugin_pkg="@jleechanorg/ao-plugin-agent-codex" ;;
    opencode)           plugin_pkg="@jleechanorg/ao-plugin-agent-opencode" ;;
    *)
      warn "unknown default agent '$default_agent' in $cfg — cannot verify plugin"
      return
      ;;
  esac
  # Check the plugin is installed in the pnpm global store
  local pnpm_home="${PNPM_HOME:-$HOME/Library/pnpm}"
  if [ -d "$pnpm_home/global/5/node_modules/$plugin_pkg" ]; then
    pass "default agent '$default_agent' resolves to installed plugin $plugin_pkg"
  elif find "$REPO_ROOT/packages/plugins" -maxdepth 1 -type d -name "*${default_agent}*" 2>/dev/null | grep -q .; then
    pass "default agent '$default_agent' resolves to source-tree plugin (workspace)"
  else
    fail "default agent '$default_agent' references plugin $plugin_pkg which is NOT installed"
  fi
}

# --- Main ---
main() {
  echo "=== ao-doctor-v2 (2026-06-10 fragility audit + 2026-06-28 followup) ==="
  if [ "${DOCTOR_CI_MODE:-0}" = "1" ]; then
    echo "(CI mode: skipping local-state-only checks — staging-config, gh-token,"
    echo " dist-md5, running.json, watchdog chain, log paths, pnpm resolution,"
    echo " launchd state, plist disk, gateway health, default-agent refs,"
    echo " to keep the gate focused on source-tree structural regressions.)"
    check_skeptic_age_filter_order
  else
    check_scm_config_in_staging
    check_defaults_agent_minimax_or_absent "$HERMES_STAGING_CONFIG" "staging"
    check_defaults_agent_minimax_or_absent "$HERMES_PROD_CONFIG" "production"
    check_defaults_agent_config_model_absent_or_global "$HERMES_STAGING_CONFIG" "staging"
    check_defaults_agent_config_model_absent_or_global "$HERMES_PROD_CONFIG" "production"
    check_skeptic_age_filter_order
    check_gh_token_not_redacted
    check_minimax_key_not_redacted
    check_dist_md5_match
    check_running_json_present
    check_ao_session_pressure
    check_orchestrator_polling_health
    check_watchdog_chain
    check_health_guardian_log_present
    check_log_path_consistency
    check_pnpm_wrapper_resolution
    check_main_repo_guard_bypass
    check_hermes_staging_launchd_state
    check_hermes_watchdog_plist_on_disk
    check_staging_gateway_health
    check_default_agent_undefined_refs
  fi
  echo "=== summary: $PASS_COUNT pass, $WARN_COUNT warn, $FAIL_COUNT fail ==="
  # Exit 1 if any FAIL so this script is CI-gateable
  [ "$FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
