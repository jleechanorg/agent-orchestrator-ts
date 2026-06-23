#!/usr/bin/env bash
# test-ao-health.sh — bash test harness for scripts/ao-health.sh
# Follows the same hand-rolled pattern as scripts/test-launchd-env.sh.
#
# Covers the four scenarios the Skeptic flagged as missing behavioral tests
# after PR #717:
#   (a) orchestrator_alive detection via `start[[:space:]](PROJECT_ALT)`
#   (b) stale running.json cleanup when PID dead
#   (c) PROJECT_ALT regex alternation matches configured projects
#   (d) anchor launch uses --no-dashboard --no-open
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more checks failed
#
# Usage: bash scripts/test-ao-health.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPERS="$SCRIPT_DIR/lib/ao-health-helpers.sh"
HEALTH_SH="$SCRIPT_DIR/ao-health.sh"

FAILED=0
PASSED=0

# Source the helpers library so we can call escape_ere, build_project_alt,
# orchestrator_pgrep_pattern, orchestrator_orphan_sweep_pattern,
# should_clean_stale_running_json, command_matches_ao_binary in isolation.
# shellcheck source=./lib/ao-health-helpers.sh
source "$HELPERS"

# ── Test framework ───────────────────────────────────────────────────────────
ok() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then ok "$label (=$actual)"
  else fail "$label: expected '$expected', got '$actual'"; fi
}

assert_match() {
  local label="$1" pattern="$2" subject="$3"
  if printf '%s' "$subject" | grep -qE -- "$pattern"; then ok "$label"
  else fail "$label: '$subject' does not match /$pattern/"; fi
}

assert_no_match() {
  local label="$1" pattern="$2" subject="$3"
  if printf '%s' "$subject" | grep -qE -- "$pattern"; then
    fail "$label: '$subject' unexpectedly matched /$pattern/"
  else
    ok "$label"
  fi
}

# ── Section 1: escape_ere ────────────────────────────────────────────────────
echo ""
echo "=== Section 1: escape_ere ==="
assert_eq "plain word passes through" "foo" "$(escape_ere 'foo')"
assert_eq "dot is escaped" 'a\.b' "$(escape_ere 'a.b')"
assert_eq "asterisk is escaped" 'a\*b' "$(escape_ere 'a*b')"
assert_eq "dollar is escaped" 'a\$b' "$(escape_ere 'a$b')"
assert_eq "parens escaped" 'a\(b\)c' "$(escape_ere 'a(b)c')"
assert_eq "project with hyphen" "my-project" "$(escape_ere 'my-project')"

# ── Section 2: build_project_alt ─────────────────────────────────────────────
echo ""
echo "=== Section 2: build_project_alt ==="
assert_eq "single project" "foo" "$(build_project_alt 'foo')"
assert_eq "two projects" "foo|bar" "$(build_project_alt 'foo bar')"
assert_eq "three projects" "foo|bar|baz" "$(build_project_alt 'foo bar baz')"
assert_eq "hyphen stays literal" "my-project|foo" "$(build_project_alt 'my-project foo')"

# ── Section 3: orchestrator_pgrep_pattern + orphan sweep pattern ─────────────
echo ""
echo "=== Section 3: pgrep pattern shape ==="
ALT="agent-orchestrator|worldarchitect|my-project"
LIVENESS_PATTERN="$(orchestrator_pgrep_pattern "$ALT")"
SWEEP_PATTERN="$(orchestrator_orphan_sweep_pattern)"
assert_eq "liveness pattern" "start[[:space:]](agent-orchestrator|worldarchitect|my-project)([[:space:]]|$)" "$LIVENESS_PATTERN"
assert_eq "sweep pattern" "start[[:space:]][a-zA-Z0-9_.-]+([[:space:]]|$)" "$SWEEP_PATTERN"

# (a) Liveness pattern must match `node <dist>/index.js start <project>` cmdline.
assert_match "liveness matches node-wrapper cmdline" "$LIVENESS_PATTERN" \
  "node /Users/jleechan/repo/packages/cli/dist/index.js start worldarchitect --no-dashboard --no-open"
assert_match "liveness matches ao-wrapper cmdline" "$LIVENESS_PATTERN" \
  "ao start worldarchitect --no-dashboard --no-open"
assert_match "liveness matches with anchor trailing" "$LIVENESS_PATTERN" \
  "node /path/index.js start agent-orchestrator"
assert_no_match "liveness rejects unrelated cmdline" "$LIVENESS_PATTERN" \
  "node /path/to/some-other-thing"

# Sweep pattern must also catch `node ... start <project>` so orphans are visible.
assert_match "sweep catches node-wrapper orchestrator" "$SWEEP_PATTERN" \
  "node /Users/jleechan/repo/packages/cli/dist/index.js start worldarchitect"
assert_match "sweep catches ao-wrapper orchestrator" "$SWEEP_PATTERN" \
  "ao start worldarchitect"

# (c) PROJECT_ALT (anchored check) matches configured projects only — the
# inner grep filter inside the orphan sweep. Test with ERE alternation.
ANCHOR_PATTERN="start[[:space:]]($ALT)([[:space:]]|\$)"
assert_match "anchor accepts configured project (no-dashboard trailing)" "$ANCHOR_PATTERN" \
  "node /p/dist/index.js start worldarchitect --no-dashboard"
assert_match "anchor accepts configured project (end-of-line)" "$ANCHOR_PATTERN" \
  "node /p/dist/index.js start agent-orchestrator"
assert_no_match "anchor rejects unconfigured project" "$ANCHOR_PATTERN" \
  "node /p/dist/index.js start some-other-project --no-dashboard"

# ── Section 4: should_clean_stale_running_json ───────────────────────────────
echo ""
echo "=== Section 4: stale running.json cleanup ==="
TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/ao-health-test.XXXXXX")"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Missing file → not stale.
if should_clean_stale_running_json "$TMPDIR_TEST/missing.json"; then
  fail "missing running.json should NOT be stale"
else
  ok "missing running.json is not stale"
fi

# running.json with a definitely-dead PID (PID 999999 — never reused on macOS).
DEAD_PID=999999
cat > "$TMPDIR_TEST/dead.json" <<EOF
{"pid": $DEAD_PID, "startedAt": "2026-06-22T18:00:00Z", "projects": ["agent-orchestrator"]}
EOF
if should_clean_stale_running_json "$TMPDIR_TEST/dead.json"; then
  ok "dead PID running.json IS stale"
else
  fail "dead PID running.json should be stale"
fi

# running.json with current shell's PID (alive) → not stale.
cat > "$TMPDIR_TEST/alive.json" <<EOF
{"pid": $$, "startedAt": "2026-06-22T18:00:00Z", "projects": ["agent-orchestrator"]}
EOF
if should_clean_stale_running_json "$TMPDIR_TEST/alive.json"; then
  fail "live PID running.json should NOT be stale"
else
  ok "live PID running.json is not stale"
fi

# running.json with non-numeric pid → not stale (no kill -0 call expected).
cat > "$TMPDIR_TEST/garbage.json" <<'EOF'
{"pid": "not-a-number", "startedAt": "2026-06-22T18:00:00Z"}
EOF
if should_clean_stale_running_json "$TMPDIR_TEST/garbage.json"; then
  fail "garbage pid should NOT be stale"
else
  ok "garbage pid is not stale (no crash)"
fi

# ── Section 5: source-level regression guards ───────────────────────────────
# (d) Anchor launch must use --no-dashboard --no-open. This is the
# regression guard for the localhost:3000 auto-open complaint.
echo ""
echo "=== Section 5: source-level regression guards ==="
if grep -qE 'start[[:space:]]+"?\$ANCHOR_PROJECT"?[[:space:]]+--no-dashboard[[:space:]]+--no-open' "$HEALTH_SH"; then
  ok "anchor launch includes --no-dashboard --no-open"
else
  fail "anchor launch must include --no-dashboard --no-open (localhost:3000 regression guard)"
fi

# Anchor launch must use the resolved AO_LAUNCH (not hard-coded 'ao start').
if grep -qE '\$\{?AO_LAUNCH\[@\]' "$HEALTH_SH"; then
  ok "anchor launch uses AO_LAUNCH array (respects source-tree AO_CLI_PATH)"
else
  fail "anchor launch must use AO_LAUNCH array"
fi

# Orphan sweep must use the helper pattern (not the brittle 'ao start' literal).
if grep -q 'orchestrator_orphan_sweep_pattern' "$HEALTH_SH"; then
  ok "orphan sweep uses orchestrator_orphan_sweep_pattern helper"
else
  fail "orphan sweep must use orchestrator_orphan_sweep_pattern helper"
fi

# Orphan sweep must NOT use the old brittle literal pattern (skip comments).
# Filter out bash comments (# lines, possibly indented) before checking.
ORPHAN_LITERAL=$(grep -vE '^[[:space:]]*#' "$HEALTH_SH" | grep -E 'pgrep[[:space:]]+-f[[:space:]]+"ao start"' || true)
if [ -n "$ORPHAN_LITERAL" ]; then
  fail "orphan sweep still uses the brittle 'ao start' literal pattern: $ORPHAN_LITERAL"
else
  ok "orphan sweep no longer uses 'ao start' literal pattern (code-only check, comments allowed)"
fi

# Stale-cleanup must use the testable helper.
if grep -q 'should_clean_stale_running_json' "$HEALTH_SH"; then
  ok "stale-cleanup uses should_clean_stale_running_json helper"
else
  fail "stale-cleanup must use should_clean_stale_running_json helper"
fi

# PROJECT_ALT must be built via the testable helper.
if grep -q 'build_project_alt' "$HEALTH_SH"; then
  ok "PROJECT_ALT built via build_project_alt helper"
else
  fail "PROJECT_ALT must be built via build_project_alt helper"
fi

# ── Section 6: shell-quoting injection regression (start-all.sh) ───────────
# The Skeptic flagged that is_lifecycle_worker_running() interpolated $project
# unescaped into python -c — fix must be in place.
echo ""
echo "=== Section 6: start-all.sh shell-quoting regression ==="
if grep -q "'\$project'" "$SCRIPT_DIR/start-all.sh"; then
  fail "start-all.sh still interpolates \$project unescaped into python (injection vector)"
else
  ok "start-all.sh does not interpolate \$project into python"
fi
# Replacement must use argv + heredoc, not python -c with bash interpolation.
if grep -q "python3 - \"\$project\"" "$SCRIPT_DIR/start-all.sh"; then
  ok "start-all.sh uses python3 - \"\$project\" argv pattern"
else
  fail "start-all.sh must use python3 argv pattern with \$project"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
echo "All checks passed."