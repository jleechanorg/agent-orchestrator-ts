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
  for label in ai.agento.health ai.agento.health-guardian ai.hermes-watchdog; do
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

# --- Main ---
main() {
  echo "=== ao-doctor-v2 (2026-06-10 fragility audit) ==="
  check_scm_config_in_staging
  check_skeptic_age_filter_order
  check_gh_token_not_redacted
  check_dist_md5_match
  check_running_json_present
  check_watchdog_chain
  echo "=== summary: $PASS_COUNT pass, $WARN_COUNT warn, $FAIL_COUNT fail ==="
  # Exit 1 if any FAIL so this script is CI-gateable
  [ "$FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
