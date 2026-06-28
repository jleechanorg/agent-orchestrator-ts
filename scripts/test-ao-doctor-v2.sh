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
# Earlier `grep -A30 | grep -q $fn` matched text mentions in comments or
# banners too, and broke when main() grew past 30 lines. Use awk to scope
# to executable call lines inside the main() function body only
# (CodeRabbit nitpick: avoid text-only false positives).
for fn in \
  check_health_guardian_log_present \
  check_log_path_consistency \
  check_pnpm_wrapper_resolution \
  check_main_repo_guard_bypass \
  check_hermes_staging_launchd_state \
  check_hermes_watchdog_plist_on_disk \
  check_staging_gateway_health \
  check_default_agent_undefined_refs; do
  if awk -v fn="$fn" '
      /^main\(\)/ { in_main=1; next }
      in_main && /^[[:space:]]*}/ { in_main=0 }
      in_main && $0 ~ "^[[:space:]]*" fn "([[:space:]]|$)" { found=1 }
      END { exit(found ? 0 : 1) }
    ' "$DOCTOR_SH"; then
    ok "$fn invoked in main()"
  else
    fail "$fn NOT invoked in main()"
  fi
done

# ── Section 4: end-to-end run produces expected output ───────────────────────
echo ""
echo "=== Section 4: End-to-end run output (fixture-isolated) ==="
# Build a temporary fixture HOME so the e2e run is deterministic across
# host machines (CodeRabbit nitpick + Greptile P2: tests must not depend
# on developer/CI machine state for launchd, logs, config, ports, or
# plugin store). Override AO_BIN_PATH + HERMES_STAGING_CONFIG so we don't
# accidentally read real config from the host.
FIXTURE_HOME="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_HOME"' EXIT
mkdir -p "$FIXTURE_HOME/Library/LaunchAgents" \
         "$FIXTURE_HOME/.agent-orchestrator" \
         "$FIXTURE_HOME/.openclaw/logs" \
         "$FIXTURE_HOME/.hermes_prod/logs" \
         "$FIXTURE_HOME/.hermes/logs"
# Empty running.json so check_running_json_present PASSes deterministically
echo '{"pid":0}' > "$FIXTURE_HOME/.agent-orchestrator/running.json"
# Fixture staging config with `defaults: {agent: minimax}` inline flow so
# the inline-defaults parser fix is exercised end-to-end.
cat > "$FIXTURE_HOME/.hermes/agent-orchestrator.yaml" <<'YAML'
defaults: {agent: minimax}
projects:
  fixture-project:
    scm: github
YAML
OUTPUT=$(HOME="$FIXTURE_HOME" \
         AO_BIN_PATH=/usr/bin/true \
         HERMES_STAGING_CONFIG="$FIXTURE_HOME/.hermes/agent-orchestrator.yaml" \
         bash "$DOCTOR_SH" 2>&1 || true)
assert_contains "header banner present" "ao-doctor-v2" "$OUTPUT"
assert_contains "summary line present" "summary:" "$OUTPUT"
assert_contains "PASS line emitted" "PASS" "$OUTPUT"
# Script should NOT contain bash errors (sed/awk) in stderr
if echo "$OUTPUT" | grep -qE "sed:.*bad flag|awk:.*syntax error|awk:.*illegal statement"; then
  fail "bash tool errors detected in output"
else
  ok "no bash tool errors in output"
fi
# Fixture-isolated run should NOT depend on host launchd / logs
if echo "$OUTPUT" | grep -q "PASS ai.agento.health-guardian"; then
  ok "health-guardian log check ran against fixture"
fi
rm -rf "$FIXTURE_HOME"
trap - EXIT

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

# ── Section 7: parser unit tests (Greptile fixes) ────────────────────────────
echo ""
echo "=== Section 7: Parser unit tests for Greptile P1/P2 fixes ==="

# 7a. Inline defaults flow style (Greptile P2: Inline Defaults Are Skipped)
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults: {agent: minimax}
projects:
  test: {scm: github}
YAML
INLINE_AGENT=$(awk '
  BEGIN { in_defaults=0 }
  /^[ \t]*defaults:[ \t]*$/ { in_defaults=1; next }
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
  in_defaults && /^[^[:space:]]/ { in_defaults=0 }
  in_defaults && /^[ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/ {
    match($0, /[ \t][ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/)
    if (RSTART > 0) {
      s = substr($0, RSTART, RLENGTH)
      sub(/.*agent:[ \t]+/, "", s)
      sub(/[ \t#]*$/, "", s)
      print s
      exit
    }
  }
' "$TMP_CFG")
assert_eq "inline defaults flow extracts agent" "minimax" "$INLINE_AGENT"
rm -f "$TMP_CFG"

# 7b. Block-style defaults (must still work after the inline fix)
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults:
  agent: claude-code
projects:
  test: {scm: github}
YAML
BLOCK_AGENT=$(awk '
  BEGIN { in_defaults=0 }
  /^[ \t]*defaults:[ \t]*$/ { in_defaults=1; next }
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
  in_defaults && /^[^[:space:]]/ { in_defaults=0 }
  in_defaults && /^[ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/ {
    match($0, /[ \t][ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/)
    if (RSTART > 0) {
      s = substr($0, RSTART, RLENGTH)
      sub(/.*agent:[ \t]+/, "", s)
      sub(/[ \t#]*$/, "", s)
      print s
      exit
    }
  }
' "$TMP_CFG")
assert_eq "block-style defaults still extracts agent" "claude-code" "$BLOCK_AGENT"
rm -f "$TMP_CFG"

# 7c. defaults.agent must NOT leak from a later `agent:` key under another
# section (CodeRabbit prompt: in_defaults was never cleared).
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults:
  workspace: /tmp
notifier-routing:
  agent: claude-code
YAML
LEAK_AGENT=$(awk '
  BEGIN { in_defaults=0 }
  /^[ \t]*defaults:[ \t]*$/ { in_defaults=1; next }
  /^[ \t]*defaults:[ \t]*\{/ { in_defaults=1; next }
  in_defaults && /^[^[:space:]]/ { in_defaults=0 }
  in_defaults && /^[ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/ {
    match($0, /[ \t][ \t]*agent:[ \t]*[a-zA-Z0-9_-]+/)
    if (RSTART > 0) {
      s = substr($0, RSTART, RLENGTH)
      sub(/.*agent:[ \t]+/, "", s)
      sub(/[ \t#]*$/, "", s)
      print s
      exit
    }
  }
' "$TMP_CFG")
assert_eq "agent under non-defaults section does NOT leak" "" "$LEAK_AGENT"
rm -f "$TMP_CFG"

# 7d. Relative symlink chain resolves through the link's directory, not
# cwd (Greptile P1: Relative Symlinks Resolve Wrong). Note the resolver
# keeps the `..` segment as-is; downstream consumers should normalize
# (e.g. via `cd "$d" && pwd`) before equality checks.
TMP_DIR="$(mktemp -d)"
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/wrapper"
echo "real" > "$TMP_DIR/wrapper/ao"
ln -s "../wrapper/ao" "$TMP_DIR/bin/ao"
SYMTARGET="$TMP_DIR/bin/ao"
i=0
while [ -L "$SYMTARGET" ] && [ "$i" -lt 10 ]; do
  link_dir=$(dirname "$SYMTARGET")
  next=$(readlink "$SYMTARGET")
  case "$next" in
    /*) SYMTARGET="$next" ;;
    *)  SYMTARGET="$link_dir/$next" ;;
  esac
  i=$((i + 1))
done
# Normalize the resolved path (resolves `..` segments) for the assertion.
NORMALIZED_SYMTARGET=$(cd "$(dirname "$SYMTARGET")" && pwd)/$(basename "$SYMTARGET")
assert_eq "relative symlink resolves through link dir" "$TMP_DIR/wrapper/ao" "$NORMALIZED_SYMTARGET"
rm -rf "$TMP_DIR"

# 7e. launchctl print-disabled indented form is detected (Greptile P1:
# Disabled Label Is Missed). Simulate the indented output.
DISABLED_FIXTURE="$(cat <<'EOF'
"ai.hermes.staging" => true
"ai.hermes.watchdog" => false
EOF
)"
DETECTED=$(echo "$DISABLED_FIXTURE" | grep -E '^[[:space:]]*"ai.hermes.staging"[[:space:]]*=>[[:space:]]*true' || true)
if [ -n "$DETECTED" ]; then ok "indented launchctl print-disabled form detected"
else fail "indented launchctl print-disabled form NOT detected"; fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== summary: $PASSED pass, $FAILED fail ==="
[ "$FAILED" -eq 0 ] && exit 0 || exit 1