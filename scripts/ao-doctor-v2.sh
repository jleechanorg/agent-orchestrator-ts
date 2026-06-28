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
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes_prod}"
HERMES_STAGING_CONFIG="${HERMES_STAGING_CONFIG:-$HOME/.hermes/agent-orchestrator.yaml}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS %s\n' "$1"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf 'WARN %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL %s\n' "$1"; }

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
  local running="$HOME/.agent-orchestrator/running.json"
  if [ ! -f "$running" ]; then
    fail "running.json missing at $running — 'ao spawn' will fail. Fix: run 'ao start' or 'setup-launchd.sh lifecycle'"
    return
  fi
  pass "running.json present at $running"
}

# --- Check 6: Tier 1 + Tier 2 + cross-watchdog all present ---
check_watchdog_chain() {
  local missing=0
  for label in ai.agento.health ai.agento.health-guardian ai.hermes.watchdog; do
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
  if [ -f "$target" ] && [[ "$target" == *"$REPO_ROOT"* ]]; then
    pass "ao binary resolves to source tree ($target)"
  elif [ -f "$target" ]; then
    warn "ao binary does NOT resolve to source tree — resolved to $target (REPO_ROOT=$REPO_ROOT). Workers may run stale code"
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
  # Check if AO_ALLOW_MAIN_REPO=1 is exported in plist
  local allow_plist="$HOME/Library/LaunchAgents/ai.agento.health.plist"
  local allow_set=0
  if [ -f "$allow_plist" ] && grep -q "AO_ALLOW_MAIN_REPO" "$allow_plist"; then
    allow_set=1
  fi
  # Check if AO_HEALTH_ANCHOR_PROJECT is set (overrides the default first
  # project). The plist is the only meaningful source of truth here —
  # scripts/ao-health.sh ALWAYS derives `ANCHOR_PROJECT` from the first
  # configured project (even on the main repo), so grepping the script
  # source for the symbol produces a false positive on every default
  # install. Removing that fallback is Greptile P1 (Source Text Becomes
  # Configuration).
  local anchor_set=0
  if [ -f "$allow_plist" ] && grep -q "AO_HEALTH_ANCHOR_PROJECT" "$allow_plist"; then
    anchor_set=1
  fi
  if [ "$allow_set" -eq 1 ] || [ "$anchor_set" -eq 1 ]; then
    pass "main-repo guard bypass configured (AO_ALLOW_MAIN_REPO=$allow_set, ANCHOR=$anchor_set)"
  else
    warn "main-repo guard bypass NOT configured — health watchdog will crash on main repo (see 2026-06-28 incident)"
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
  local staging_cfg="$HERMES_STAGING_CONFIG"
  local port=8644  # default staging port per ~/.hermes/agent-orchestrator.yaml
  if [ -f "$staging_cfg" ]; then
    # Use awk (BSD-portable) instead of sed+BRE because \t is not portable
    port=$(grep -E "port:|listen_port:" "$staging_cfg" 2>/dev/null \
           | head -1 \
           | awk '{
             for (i=1; i<=NF; i++) {
               if ($i ~ /^[0-9]+$/) { print $i; exit }
             }
           }')
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
  default_agent=$(awk '
    BEGIN { in_defaults=0 }
    # Multi-line defaults block opener
    /^[ \t]*defaults:[ \t]*$/ { in_defaults=1; next }
    # Inline flow opener: defaults: {agent: ...}
    /^[ \t]*defaults:[ \t]*\{/ {
      in_defaults=1
      line = $0
      if (match(line, /agent:[ \t]*[a-zA-Z0-9_-]+/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*agent:[ \t]+/, "", s)
        sub(/[ \t,}]*$/, "", s)
        print s
        exit
      }
      next
    }
    # Reset when leaving the defaults block
    in_defaults && /^[^[:space:]]/ { in_defaults=0 }
    # Block-style `agent:` line under defaults
    in_defaults && /^[ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/ {
      # POSIX awk: use match()+substr() (gawk array extension is not portable)
      match($0, /[ \t][ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/)
      if (RSTART > 0) {
        s = substr($0, RSTART, RLENGTH)
        sub(/.*agent:[ \t]+/, "", s)
        sub(/[ \t#]*$/, "", s)
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
    check_skeptic_age_filter_order
    check_gh_token_not_redacted
    check_dist_md5_match
    check_running_json_present
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
