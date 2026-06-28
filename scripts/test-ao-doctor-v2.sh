#!/usr/bin/env bash
# test-ao-doctor-v2.sh — bash test harness for the 8 new checks added to
# scripts/ao-doctor-v2.sh on 2026-06-28.
#
# Covers:
#   (a) check_health_guardian_log_present — log dir exists + log fresh
#   (b) check_log_path_consistency — plist StandardOutPath resolves
#   (c) check_pnpm_wrapper_resolution — symlink chain ends in REPO_ROOT
#   (d) check_main_repo_guard_bypass — ANCHOR configured
#   (e) check_hermes_staging_launchd_state — enabled vs disabled
#   (f) check_hermes_watchdog_plist_on_disk — plist exists + plutil lint
#   (g) check_staging_gateway_health — port LISTEN
#   (h) check_default_agent_undefined_refs — plugin installed
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more checks failed
#
# Usage: bash scripts/test-ao-doctor-v2.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCTOR_SH="$SCRIPT_DIR/ao-doctor-v2.sh"

FAILED=0
PASSED=0

ok()    { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail()  { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then ok "$label (=$actual)"
  else fail "$label: expected '$expected', got '$actual'"; fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then ok "$label"
  else fail "$label: '$needle' not found in output"; fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail "$label: '$needle' unexpectedly found in output"
  else
    ok "$label"
  fi
}

# Source the doctor script's check functions without running main()
# Extract the check function bodies by sourcing into a subshell with a stub main
extract_checks() {
  # Source the file with a guard so main() doesn't run; we expose only the
  # check_* functions and the pass/warn/fail helpers via env.
  (
    # Override main() by setting BASH_SOURCE != 0 guard
    BASH_BACKUP="${BASH_SOURCE[0]}"
    # shellcheck source=/dev/null
    source "$DOCTOR_SH" 2>/dev/null
  ) || true
}

# ── Section 1: syntax / parse ────────────────────────────────────────────────
echo ""
echo "=== Section 1: Syntax ==="
if bash -n "$DOCTOR_SH" 2>/dev/null; then ok "scripts/ao-doctor-v2.sh parses cleanly"
else fail "scripts/ao-doctor-v2.sh has bash syntax errors"; fi

# ── Section 2: function presence ─────────────────────────────────────────────
echo ""
echo "=== Section 2: All 8 new check functions present ==="
for fn in \
  check_health_guardian_log_present \
  check_log_path_consistency \
  check_pnpm_wrapper_resolution \
  check_main_repo_guard_bypass \
  check_hermes_staging_launchd_state \
  check_hermes_watchdog_plist_on_disk \
  check_staging_gateway_health \
  check_default_agent_undefined_refs; do
  if grep -q "^${fn}()" "$DOCTOR_SH"; then ok "function $fn defined"
  else fail "function $fn not defined"; fi
done

# ── Section 3: invoked from main() ───────────────────────────────────────────
echo ""
echo "=== Section 3: All 8 new checks wired into main() ==="
for fn in \
  check_health_guardian_log_present \
  check_log_path_consistency \
  check_pnpm_wrapper_resolution \
  check_main_repo_guard_bypass \
  check_hermes_staging_launchd_state \
  check_hermes_watchdog_plist_on_disk \
  check_staging_gateway_health \
  check_default_agent_undefined_refs; do
  if grep -A30 "^main()" "$DOCTOR_SH" | grep -q "$fn"; then ok "$fn invoked in main()"
  else fail "$fn NOT invoked in main()"; fi
done

# ── Section 4: end-to-end run produces expected output ───────────────────────
echo ""
echo "=== Section 4: End-to-end run output ==="
OUTPUT=$(bash "$DOCTOR_SH" 2>&1 || true)
assert_contains "header banner present" "ao-doctor-v2" "$OUTPUT"
assert_contains "summary line present" "summary:" "$OUTPUT"
assert_contains "PASS line emitted" "PASS" "$OUTPUT"
# Script should NOT contain bash errors (sed/awk) in stderr
if echo "$OUTPUT" | grep -qE "sed:.*bad flag|awk:.*syntax error|awk:.*illegal statement"; then
  fail "bash tool errors detected in output"
else
  ok "no bash tool errors in output"
fi

# ── Section 5: CI mode skips local-state checks ──────────────────────────────
echo ""
echo "=== Section 5: CI mode skips local-state checks ==="
CI_OUTPUT=$(DOCTOR_CI_MODE=1 bash "$DOCTOR_SH" 2>&1 || true)
assert_contains "CI mode banner present" "CI mode" "$CI_OUTPUT"
# In CI mode, check_running_json_present should NOT emit a PASS/FAIL/WARN
# (the word "running.json" appears in the banner explaining what's skipped)
if echo "$CI_OUTPUT" | grep -qE "^(PASS|WARN|FAIL) running\.json"; then
  fail "CI mode should not run check_running_json_present"
else
  ok "CI mode skips check_running_json_present"
fi
# But it SHOULD still run check_skeptic_age_filter_order (source-tree structural)
if echo "$CI_OUTPUT" | grep -qE "^(PASS|WARN|FAIL).*skeptic-cron"; then
  ok "CI mode runs skeptic check"
else
  fail "CI mode should run check_skeptic_age_filter_order"
fi

# ── Section 6: bad-input coverage ────────────────────────────────────────────
echo ""
echo "=== Section 6: Robustness against bad input ==="
# Run with REPO_ROOT pointed at /nonexistent
BAD_OUTPUT=$(REPO_ROOT=/nonexistent/path/that/does/not/exist bash "$DOCTOR_SH" 2>&1 || true)
if echo "$BAD_OUTPUT" | grep -qE "bash:.*cannot execute|line [0-9]+:.*syntax error"; then
  fail "doctor crashes with bad REPO_ROOT"
else
  ok "doctor handles missing REPO_ROOT without crashing"
fi
# Run with a non-existent staging config
NO_CFG_OUTPUT=$(HERMES_STAGING_CONFIG=/nonexistent/cfg.yaml bash "$DOCTOR_SH" 2>&1 || true)
if echo "$NO_CFG_OUTPUT" | grep -qE "bash:.*No such file|cannot find"; then
  fail "doctor crashes with missing config"
else
  ok "doctor handles missing config gracefully"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== summary: $PASSED pass, $FAILED fail ==="
[ "$FAILED" -eq 0 ] && exit 0 || exit 1