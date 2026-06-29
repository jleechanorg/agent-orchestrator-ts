#!/usr/bin/env bash
# test-doctor-lifecycle-cmdline.sh — bash test harness for the per-project
# lifecycle check in scripts/ao-doctor.sh. Verifies that the check accepts
# BOTH the legacy `lifecycle-worker <project>` subprocess shape AND the
# current in-process `start <project>` orchestrator shape introduced by
# the in-process lifecycle refactor (PR #712 / lifecycle-service.ts).
#
# Bug history: PR #732 added 8 doctor checks and the per-project
# lifecycle-worker check began emitting `WARN: no lifecycle-worker process
# found for project 'X'` for every configured project — because the
# in-process orchestrator is launched as `node <dist>/index.js start <project>`,
# not as `lifecycle-worker <project>`. This test pins down the correct
# behavior so the bug can't regress.
#
# Mirrors the test pattern from scripts/test-ao-health.sh:
#   - extract pure helpers into scripts/lib/ao-doctor-helpers.sh
#   - source them and assert behavior in isolation
#   - mock `ps` via a temp bin dir on PATH (so check_lifecycle_workers
#     uses controlled process-list output)
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPERS_SH="$SCRIPT_DIR/lib/ao-doctor-helpers.sh"
DOCTOR_SH="$SCRIPT_DIR/ao-doctor.sh"

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

# ── Section 1: helpers file exists and parses ────────────────────────────────
echo ""
echo "=== Section 1: helpers file syntax ==="
if [ ! -f "$HELPERS_SH" ]; then
  fail "scripts/lib/ao-doctor-helpers.sh does not exist"
  echo ""
  echo "Results: $PASSED PASS, $FAILED FAIL"
  exit 1
fi
if bash -n "$HELPERS_SH" 2>/dev/null; then ok "ao-doctor-helpers.sh parses cleanly"
else fail "ao-doctor-helpers.sh has bash syntax errors"; fi

# shellcheck source=/dev/null
source "$HELPERS_SH"

# ── Section 2: helper function presence ───────────────────────────────────────
echo ""
echo "=== Section 2: required helper functions defined ==="
for fn in cmdline_references_project count_orchestrators_for_project escape_ere; do
  if declare -F "$fn" >/dev/null 2>&1; then ok "function $fn defined"
  else fail "function $fn not defined"; fi
done

# ── Section 3: cmdline_references_project — pure string matcher ───────────────
echo ""
echo "=== Section 3: cmdline_references_project unit tests ==="

# 3a. Legacy subprocess shape: `lifecycle-worker <project>` matches
if cmdline_references_project \
    "node /path/to/dist/index.js lifecycle-worker agent-orchestrator" \
    "agent-orchestrator"; then
  ok "legacy lifecycle-worker cmdline matches"
else
  fail "legacy lifecycle-worker cmdline should match"
fi

# 3b. In-process shape: `start <project>` matches (the regression)
if cmdline_references_project \
    "node /path/to/dist/index.js start agent-orchestrator --no-dashboard" \
    "agent-orchestrator"; then
  ok "in-process start <project> cmdline matches"
else
  fail "in-process start <project> cmdline should match (regression for false-positive WARN)"
fi

# 3c. Plain `ao start <project>` (symlink wrapper) also matches
if cmdline_references_project \
    "/Users/jleechan/bin/ao start worldarchitect --no-open" \
    "worldarchitect"; then
  ok "ao symlink start <project> cmdline matches"
else
  fail "ao symlink start <project> cmdline should match"
fi

# 3d. Wrong project: must NOT match
if cmdline_references_project \
    "node /path/to/dist/index.js start other-project" \
    "agent-orchestrator"; then
  fail "wrong project 'other-project' should not match 'agent-orchestrator'"
else
  ok "wrong project does not match"
fi

# 3e. False-positive guard: partial match like 'lifecycle-worker api-v2' must not match 'api'
if cmdline_references_project \
    "node /path/to/dist/index.js lifecycle-worker api-v2" \
    "api"; then
  fail "partial project 'api' should not match 'api-v2' lifecycle-worker"
else
  ok "partial project 'api' does not match 'api-v2'"
fi

# 3e2. False-positive guard (suffix): 'lifecycle-worker my-api' must not match 'api'
# (catches the regex bug where `[^[:space:]]*${proj}` allowed any prefix tokens)
if cmdline_references_project \
    "node /path/to/dist/index.js lifecycle-worker my-api" \
    "api"; then
  fail "suffix project 'api' should not match 'lifecycle-worker my-api'"
else
  ok "suffix project 'api' does not match 'lifecycle-worker my-api'"
fi

# 3e3. False-positive guard (suffix): 'start my-api' must not match 'api'
if cmdline_references_project \
    "node /path/to/dist/index.js start my-api --flag" \
    "api"; then
  fail "suffix project 'api' should not match 'start my-api'"
else
  ok "suffix project 'api' does not match 'start my-api'"
fi

# 3f. False-positive guard: doc filenames must not match
if cmdline_references_project \
    "vim docs/ao-lifecycle-triage.md" \
    "agent-orchestrator"; then
  fail "doc filename must not match 'lifecycle-worker <project>'"
else
  ok "doc filename does not match"
fi

# 3g. Project name with regex meta chars (e.g. 'my.project.v2') must be escaped
if cmdline_references_project \
    "node /path/to/dist/index.js start my.project.v2" \
    "my.project.v2"; then
  ok "project name with dots matches (escape_ere handling)"
else
  fail "project name with dots should match after escape_ere"
fi

# 3h. Empty cmdline does not match
if cmdline_references_project "" "agent-orchestrator"; then
  fail "empty cmdline should not match"
else
  ok "empty cmdline does not match"
fi

# ── Section 4: count_orchestrators_for_project — works on a ps snapshot ──────
echo ""
echo "=== Section 4: count_orchestrators_for_project unit tests ==="

# 4a. Empty ps output: count is 0
EMPTY_PS=""
assert_eq "empty ps output count for project" "0" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$EMPTY_PS")"

# 4b. Single in-process orchestrator for the project
PS_INPROC=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js start agent-orchestrator --no-dashboard\n')
assert_eq "in-process orchestrator present: count is 1" "1" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$PS_INPROC")"

# 4c. Wrong project, no match
PS_OTHER=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js start other-project\n')
assert_eq "in-process for other project: count is 0" "0" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$PS_OTHER")"

# 4d. Legacy subprocess present
PS_LEGACY=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js lifecycle-worker agent-orchestrator\n')
assert_eq "legacy lifecycle-worker present: count is 1" "1" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$PS_LEGACY")"

# 4e. Mixed: legacy + in-process for same project
PS_MIXED=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js start agent-orchestrator --no-dashboard\nuser  200  /usr/bin/node /path/to/dist/index.js lifecycle-worker agent-orchestrator\n')
assert_eq "mixed legacy + in-process: count is 2" "2" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$PS_MIXED")"

# 4f. Multiple in-process orchestrators (shouldn't happen, but counted for safety)
PS_DUP_INPROC=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js start agent-orchestrator\nuser  200  /usr/bin/node /path/to/dist/index.js start agent-orchestrator\n')
assert_eq "duplicate in-process: count is 2" "2" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$PS_DUP_INPROC")"

# 4g. False-positive guard: snapshot with suffix 'my-api' for legacy must not count for 'api'
PS_SUFFIX_LEGACY=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js lifecycle-worker my-api\n')
assert_eq "legacy suffix 'my-api' does not match project 'api'" "0" \
    "$(count_orchestrators_for_project 'api' "$PS_SUFFIX_LEGACY")"

# 4h. False-positive guard: snapshot with suffix 'my-api' for in-process must not count for 'api'
PS_SUFFIX_INPROC=$(printf 'user  100  /usr/bin/node /path/to/dist/index.js start my-api\n')
assert_eq "in-process suffix 'my-api' does not match project 'api'" "0" \
    "$(count_orchestrators_for_project 'api' "$PS_SUFFIX_INPROC")"

# ── Section 5: end-to-end check_lifecycle_workers — RED test (mock ps) ──────
echo ""
echo "=== Section 5: end-to-end check_lifecycle_workers with mocked ps ==="
# This is the regression test for the false-positive WARN reported after
# PR #732. We set up a fixture config + a mock `ps` binary on PATH that
# returns an in-process orchestrator cmdline, and we assert the WARN
# "no lifecycle-worker process found for project 'X'" does NOT fire.

# Skip the e2e section if the doctor script cannot be sourced (e.g.
# python3 not available). The pure helper tests above are still authoritative.
if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not available — skipping Section 5 e2e checks"
else
  # Build a fixture HOME with a minimal config + staging dir
  FIXTURE_HOME="$(mktemp -d)"
  trap 'rm -rf "$FIXTURE_HOME"' EXIT
  mkdir -p "$FIXTURE_HOME/.agent-orchestrator" \
           "$FIXTURE_HOME/.hermes"
  cat > "$FIXTURE_HOME/.hermes/agent-orchestrator.yaml" <<'YAML'
defaults: {agent: minimax}
projects:
  agent-orchestrator: {scm: github}
  worldarchitect: {scm: github}
YAML

  # Build a mock `ps` that returns a process list with an in-process
  # orchestrator for `agent-orchestrator` only — `worldarchitect` is missing.
  MOCK_BIN="$(mktemp -d)"
  trap 'rm -rf "$FIXTURE_HOME" "$MOCK_BIN"' EXIT
  cat > "$MOCK_BIN/ps" <<'PS_EOF'
#!/usr/bin/env bash
# Mock ps: emit one in-process orchestrator for agent-orchestrator
# and NO orchestrator for worldarchitect (to verify the WARN still
# fires correctly when no orchestrator is present).
cat <<'MOCK_EOF'
user  1234  1.0  0.5 123456 7890 ??  S    10:00AM   0:01.23 /usr/bin/node /Users/jleechan/.local/share/pnpm/global/5/node_modules/@jleechanorg/ao-cli/dist/index.js start agent-orchestrator --no-dashboard
user  9999  0.0  0.1   1234  5678 ??  S    10:00AM   0:00.01 /usr/bin/some-other-daemon
MOCK_EOF
PS_EOF
  chmod +x "$MOCK_BIN/ps"

  # Source the doctor script in a subshell-like scope with PATH override.
  # We use HOME override + PATH override so `ps` resolves to our mock
  # and the config lookup picks up the fixture config.
  OUTPUT=$(HOME="$FIXTURE_HOME" \
           PATH="$MOCK_BIN:$PATH" \
           AO_REPO_ROOT="$REPO_ROOT" \
           AO_STAGING_CONFIG_PATH="$FIXTURE_HOME/.hermes/agent-orchestrator.yaml" \
           FIXTURE_MODE=1 \
           bash -c "source '$DOCTOR_SH' 2>/dev/null && check_lifecycle_workers" \
           2>&1 || true)

  assert_not_contains "agent-orchestrator: no false-positive WARN" \
    "no lifecycle-worker process found for project 'agent-orchestrator'" \
    "$OUTPUT"
  assert_contains "agent-orchestrator: PASS line for in-process orchestrator" \
    "agent-orchestrator" "$OUTPUT"
  assert_contains "worldarchitect: WARN still fires (truly missing orchestrator)" \
    "no lifecycle-worker process found for project 'worldarchitect'" \
    "$OUTPUT"
fi

# ── Section 6: regression test — bug-shape lock ─────────────────────────────
# Pin down the bug introduced by the per-project check in scripts/ao-doctor.sh
# after PR #712. The original check used:
#
#   ps aux | grep -v grep | grep -E -w "lifecycle-worker[[:space:]].*\$proj($|[[:space:]])" | wc -l
#
# This pattern ONLY matches the legacy `lifecycle-worker <proj>` subprocess
# shape. After PR #712 the lifecycle runs in-process inside `ao start <proj>`,
# so the count is always 0 and the WARN fires for every configured project.
#
# This regression test asserts the OPPOSITE: a process list containing ONLY
# the in-process shape must produce a count >= 1 (the check accepts it).
# If the per-project check ever reverts to the legacy-only pattern, the
# new count helper will report 0 and the WARN will spuriously fire — and
# this test will fail.
echo ""
echo "=== Section 6: regression — in-process shape alone must match ==="

# Build a ps snapshot that contains ONLY the in-process shape (no
# `lifecycle-worker` substrings). If the helper only accepted the
# legacy shape, the count would be 0.
INPROC_ONLY_SNAPSHOT=$(printf 'user  100  1.0  0.5 100000 8000 ??  S    10:00AM   0:00.50 /usr/bin/node /path/to/dist/index.js start agent-orchestrator --no-dashboard\n')

assert_eq "in-process-only snapshot: count is 1 (regression lock)" "1" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$INPROC_ONLY_SNAPSHOT")"

# The same snapshot fed to the OLD pattern should be 0 (proves the bug
# exists in the old code path).
# `|| true` is required: grep returns 1 on no match, and `set -o pipefail`
# would otherwise abort the script under `set -e`.
OLD_PATTERN_COUNT=$(printf '%s\n' "$INPROC_ONLY_SNAPSHOT" \
    | grep -E -w "lifecycle-worker[[:space:]].*agent-orchestrator($|[[:space:]])" \
    | wc -l | tr -d ' ' || true)
assert_eq "old legacy-only pattern returns 0 against in-process snapshot" "0" \
    "$OLD_PATTERN_COUNT"

# Cross-check: the new pattern is strictly broader than the old one.
# It must match every process the old pattern matches (forward-compat
# with legacy launches) AND the in-process shape (current model).
LEGACY_ONLY_SNAPSHOT=$(printf 'user  100  1.0  0.5 100000 8000 ??  S    10:00AM   0:00.50 /usr/bin/node /path/to/dist/index.js lifecycle-worker agent-orchestrator\n')
assert_eq "legacy-only snapshot: new helper still counts it (forward-compat)" "1" \
    "$(count_orchestrators_for_project 'agent-orchestrator' "$LEGACY_ONLY_SNAPSHOT")"

echo ""
echo "Results: $PASSED PASS, $FAILED FAIL"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
