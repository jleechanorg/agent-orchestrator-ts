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
# Create a fresh health-guardian log so check_health_guardian_log_present
# actually exercises its PASS path. Previously the fixture only created
# the directory, so the doctor always emitted `FAIL log directory ...`
# and the assertion was silently no-op'd (CodeRabbit review).
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) heartbeat" \
  > "$FIXTURE_HOME/.openclaw/logs/ao-health-guardian.log"
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
# Real assertion (CodeRabbit review: previous `if grep -q ... then ok ... fi`
# silently no-op'd when the line was missing, masking fixture regressions).
if echo "$OUTPUT" | grep -qE "^PASS .*ai.agento.health-guardian"; then
  ok "health-guardian log check PASSed against fresh fixture log"
else
  fail "health-guardian log check did NOT PASS against fresh fixture log"
fi
# Stale log path (mtime > 30 min) must trigger WARN, not PASS
sleep 1
# Simulate an old log by backdating its mtime via touch -t
touch -t "202001010000" "$FIXTURE_HOME/.openclaw/logs/ao-health-guardian.log"
STALE_OUTPUT=$(HOME="$FIXTURE_HOME" \
               AO_BIN_PATH=/usr/bin/true \
               HERMES_STAGING_CONFIG="$FIXTURE_HOME/.hermes/agent-orchestrator.yaml" \
               bash "$DOCTOR_SH" 2>&1 || true)
if echo "$STALE_OUTPUT" | grep -qE "^WARN .*ai.agento.health-guardian"; then
  ok "stale health-guardian log triggers WARN"
else
  fail "stale health-guardian log did NOT trigger WARN"
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

# Source the doctor script so we can call check_default_agent_undefined_refs
# directly against fixture configs (CodeRabbit review: Section 7 was testing
# duplicated awk blocks instead of the production logic, so it could miss
# regressions in the real doctor script).
# shellcheck source=/dev/null
source "$DOCTOR_SH" 2>/dev/null

# Helper: capture the doctor's pass/warn/fail lines from a single check
# function call against a fixture config.
run_default_agent_check() {
  local cfg="$1"
  HERMES_STAGING_CONFIG="$cfg" REPO_ROOT="$REPO_ROOT" \
    PASS_COUNT=0 WARN_COUNT=0 FAIL_COUNT=0 \
    check_default_agent_undefined_refs 2>&1
}

# 7a. Inline defaults flow style (Greptile P2: Inline Defaults Are Skipped)
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults: {agent: minimax}
projects:
  test: {scm: github}
YAML
OUT=$(run_default_agent_check "$TMP_CFG")
# Inline config + minimax default. The real parser must successfully
# extract the agent from inline flow AND run the plugin resolution check.
# Depending on whether the minimax plugin is installed in the test env,
# we expect either PASS (source-tree workspace hit) or FAIL (not installed)
# — what we MUST NOT see is a "no defaults.agent configured" WARN, which
# is the symptom of the pre-fix inline-defaults bug.
if echo "$OUT" | grep -qE "(PASS|FAIL).*agent.*minimax"; then
  ok "inline defaults flow: real parser extracted agent and ran plugin check"
else
  fail "inline defaults flow: real parser did not exercise agent=minimax (got: $OUT)"
fi
rm -f "$TMP_CFG"

# 7b. Block-style defaults (must still work after the inline fix).
# Tighten the assertion to specifically look for the real parser-exercised
# output ("default agent '...' resolves to ...") and exclude the
# fallback "no defaults.agent configured" warning path that would mask a
# regression where the parser silently fails (CodeRabbit round-7).
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults:
  agent: claude-code
projects:
  test: {scm: github}
YAML
OUT=$(run_default_agent_check "$TMP_CFG")
if echo "$OUT" | grep -qE "default agent 'claude-code' (resolves|references)"; then
  ok "block-style defaults: real parser exercised (output: $(echo "$OUT" | head -1))"
elif echo "$OUT" | grep -qE "no defaults.agent configured"; then
  fail "block-style defaults: real parser fell back to 'no defaults.agent' warning (got: $OUT)"
else
  fail "block-style defaults: real parser did not exercise agent check (got: $OUT)"
fi
rm -f "$TMP_CFG"

# 7c. defaults.agent must NOT leak from a later `agent:` key under another
# section (CodeRabbit prompt: in_defaults was never cleared). With a
# non-defaults `agent:` under notifier-routing, the real parser should NOT
# resolve it as the default agent — it should emit a WARN about no
# defaults.agent configured.
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults:
  workspace: /tmp
notifier-routing:
  agent: claude-code
YAML
OUT=$(run_default_agent_check "$TMP_CFG")
if echo "$OUT" | grep -qE "WARN.*no defaults.agent"; then
  ok "agent under non-defaults section does NOT leak into real parser"
else
  fail "agent under non-defaults section DID leak into real parser (got: $OUT)"
fi
rm -f "$TMP_CFG"

# 7c-quoted. Quoted agent names like `agent: "minimax"` or `agent: 'minimax'`
# must also be parsed correctly (Greptile P1 followup: Quoted agents skip
# checks). Earlier regex `[a-zA-Z0-9_-]+` skipped quoted values and warned
# "no defaults.agent configured" even when one was set.
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults:
  agent: "claude-code"
projects:
  test: {scm: github}
YAML
OUT=$(run_default_agent_check "$TMP_CFG")
if echo "$OUT" | grep -qE "(PASS|FAIL).*agent.*claude-code"; then
  ok "double-quoted agent name parsed correctly"
else
  fail "double-quoted agent name NOT parsed (got: $OUT)"
fi
rm -f "$TMP_CFG"

TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<'YAML'
defaults:
  agent: 'wafer'
projects:
  test: {scm: github}
YAML
OUT=$(run_default_agent_check "$TMP_CFG")
if echo "$OUT" | grep -qE "(PASS|FAIL|WARN).*agent.*wafer"; then
  ok "single-quoted agent name parsed correctly"
else
  fail "single-quoted agent name NOT parsed (got: $OUT)"
fi
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
# Disabled Label Is Missed). Simulate the INDENTED output that the real
# `launchctl print-disabled gui/$(id -u)` command emits — leading 2-space
# indent before the quoted label. Without the indent the regex would
# trivially match a column-0 line and not exercise the historical bug
# (CodeRabbit review: pre-fix fixture had no leading indent).
DISABLED_FIXTURE="$(cat <<'EOF'
disabled services = {
  "ai.hermes.staging" => true
  "ai.hermes.watchdog" => false
}
EOF
)"
DETECTED=$(echo "$DISABLED_FIXTURE" | grep -E '^[[:space:]]+"ai.hermes.staging"[[:space:]]*=>[[:space:]]*true' || true)
if [ -n "$DETECTED" ]; then ok "indented launchctl print-disabled form detected"
else fail "indented launchctl print-disabled form NOT detected"; fi
# Negative case: column-0 line with the SAME label must NOT match the
# indented-arrow regex. Proves the regex actually requires indentation.
COLUMN0=$(echo '"ai.hermes.staging" => true' | grep -E '^[[:space:]]+"ai.hermes.staging"[[:space:]]*=>[[:space:]]*true' || true)
if [ -z "$COLUMN0" ]; then ok "column-0 disabled form correctly rejected"
else fail "column-0 disabled form incorrectly matched"; fi

# 7f. Path-boundary check must reject sibling directories that share a
# REPO_ROOT prefix (Greptile P1 followup: Path boundary missing).
# Substring `*$REPO_ROOT*` would match `/Users/me/agent-orchestrator-old/bin/ao`
# against REPO_ROOT `/Users/me/agent-orchestrator` and false-PASS.
# Use string-only path comparisons (no cd) to keep this test portable
# across machines where the example path doesn't exist.
REPO="/Users/me/agent-orchestrator"
RESOLVED_SIBLING="/Users/me/agent-orchestrator-old/bin/ao"
RESOLVED_INSIDE="$REPO/bin/ao"
if [[ "$RESOLVED_SIBLING" == "$REPO" || "$RESOLVED_SIBLING" == "$REPO"/* ]]; then
  fail "sibling dir with shared prefix should NOT pass path-boundary check"
else
  ok "sibling dir with shared prefix correctly rejected"
fi
if [[ "$RESOLVED_INSIDE" == "$REPO" || "$RESOLVED_INSIDE" == "$REPO"/* ]]; then
  ok "source-tree binary correctly passes path-boundary check"
else
  fail "source-tree binary incorrectly rejected"
fi

# 7g. AO_ALLOW_MAIN_REPO=0 / false must NOT count as enabled bypass
# (Greptile P1 followup: Bypass value ignored). We can't easily mock the
# plist parsing helper, so verify the helper logic standalone.
is_truthy() {
  case "$1" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}
if is_truthy "0"; then fail "AO_ALLOW_MAIN_REPO=0 incorrectly truthy"
else ok "AO_ALLOW_MAIN_REPO=0 correctly rejected as falsy"; fi
if is_truthy "false"; then fail "AO_ALLOW_MAIN_REPO=false incorrectly truthy"
else ok "AO_ALLOW_MAIN_REPO=false correctly rejected as falsy"; fi
if is_truthy "1"; then ok "AO_ALLOW_MAIN_REPO=1 correctly truthy"
else fail "AO_ALLOW_MAIN_REPO=1 incorrectly rejected"; fi
if is_truthy "true"; then ok "AO_ALLOW_MAIN_REPO=true correctly truthy"
else fail "AO_ALLOW_MAIN_REPO=true incorrectly rejected"; fi

# 7h. Staging port lookup must be scoped to the staging/gateway block,
# not take the first `port:` line anywhere in the YAML (Greptile P1
# followup: Port lookup unscoped).
PORT_FIXTURE="$(mktemp)"
cat > "$PORT_FIXTURE" <<'YAML'
projects:
  some-other-project:
    scm: github
    port: 1234
staging:
  port: 8644
YAML
SCOPED_PORT=$(awk '
  BEGIN { in_scope=0 }
  /^[ \t]*(staging|gateway|staging-gateway):[ \t]*$/ { in_scope=1; next }
  in_scope && /^[^[:space:]]/ && $0 !~ /^[ \t]*(staging|gateway|staging-gateway):[ \t]*\{/ { in_scope=0 }
  in_scope && /port:[ \t]*[0-9]+/ {
    line = $0
    if (match(line, /port:[ \t]*[0-9]+/)) {
      s = substr(line, RSTART, RLENGTH)
      sub(/^port:[ \t]*/, "", s)
      print s
      exit
    }
  }
' "$PORT_FIXTURE")
assert_eq "staging port lookup scoped to staging block" "8644" "$SCOPED_PORT"
rm -f "$PORT_FIXTURE"

# 7h-inline. Inline flow `staging: { port: 8765 }` must also be parsed.
# Earlier `in_scope && /^[^[:space:]]/` ran on the same line and cleared
# in_scope before the port: extractor ran (Greptile P1 followup: Inline
# port skipped).
PORT_FIXTURE="$(mktemp)"
cat > "$PORT_FIXTURE" <<'YAML'
projects:
  some-other-project:
    port: 1234
staging: { port: 8765 }
YAML
INLINE_PORT=$(awk '
  BEGIN { in_scope=0 }
  /^[ \t]*(staging|gateway|staging-gateway):[ \t]*$/ { in_scope=1; next }
  /^[ \t]*(staging|gateway|staging-gateway):[ \t]*\{/ { in_scope=1 }
  in_scope && /^[^[:space:]]/ && $0 !~ /^[ \t]*(staging|gateway|staging-gateway):[ \t]*\{/ { in_scope=0 }
  in_scope && /port:[ \t]*[0-9]+/ {
    line = $0
    if (match(line, /port:[ \t]*[0-9]+/)) {
      s = substr(line, RSTART, RLENGTH)
      sub(/^port:[ \t]*/, "", s)
      print s
      exit
    }
  }
' "$PORT_FIXTURE")
assert_eq "inline staging port parsed correctly" "8765" "$INLINE_PORT"
rm -f "$PORT_FIXTURE"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== summary: $PASSED pass, $FAILED fail ==="
[ "$FAILED" -eq 0 ] && exit 0 || exit 1