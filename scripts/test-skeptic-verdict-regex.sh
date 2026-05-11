#!/usr/bin/env bash
# Regression tests for VERDICT capture regex in skeptic-cron-reusable.yml,
# skeptic-gate-reusable.yml, and test.yml.
# Exercises the exact jq capture pattern from the workflow YAML files.
# NOTE: ^ anchor with m flag is jq-version-dependent (works on Ubuntu GHA runner,
# may not work on macOS jq 1.7.1). JSON body tests use jq --arg for input
# to guarantee correct newline handling across jq versions.
set -euo pipefail

pass() { echo "OK: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Exact pattern from the three workflow YAML files
FULL_PATTERN='^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)\b(?:\*{1,2})?[ \t]*(?:[-—:][^\n]*)?'
# Simplified pattern (without ^ anchor) for macOS jq compatibility
CORE_PATTERN='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)\b(?:\*{1,2})?[ \t]*(?:[-—:][^\n]*)?'

# Test using jq --arg for JSON body construction (safe for any content including
# quotes, backslashes, and special characters — avoids Python string interpolation).
test_verdict() {
  local body="$1" expected="$2" label="$3" pattern="${4:-$FULL_PATTERN}"
  actual=$(jq -n --arg body "$body" --arg re "$pattern" \
    '$body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# Test the old broken pattern ($ anchor) vs new pattern (word boundary)
test_old_vs_new() {
  local body="$1" old_expected="$2" new_expected="$3" label="$4"
  OLD_PATTERN='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$'
  NEW_PATTERN='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)\b(?:\*{1,2})?[ \t]*(?:[-—:][^\n]*)?'

  old_actual=$(jq -n --arg body "$body" --arg re "$OLD_PATTERN" \
    '$body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')
  new_actual=$(jq -n --arg body "$body" --arg re "$NEW_PATTERN" \
    '$body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')

  old_ok="OK"; new_ok="OK"
  [ "$old_actual" = "$old_expected" ] || old_ok="FAIL(got '$old_actual')"
  [ "$new_actual" = "$new_expected" ] || new_ok="FAIL(got '$new_actual')"
  echo "RED-GREEN $label: old=$old_ok new=$new_ok"
  [ "$old_actual" = "$old_expected" ] && [ "$new_actual" = "$new_expected" ] || \
    fail "$label — old expected '$old_expected' got '$old_actual', new expected '$new_expected' got '$new_actual'"
}

# === Tests using FULL_PATTERN (exact workflow regex with ^ anchor) ===
echo "--- Full pattern tests (matches workflow YAML exactly) ---"
test_verdict "VERDICT: PASS" "PASS" "FULL: simple PASS" "$FULL_PATTERN"
test_verdict "VERDICT: FAIL" "FAIL" "FULL: simple FAIL" "$FULL_PATTERN"
test_verdict "VERDICT: SKIPPED" "SKIPPED" "FULL: simple SKIPPED" "$FULL_PATTERN"
test_verdict "VERDICT: PASS — all gates green" "PASS" "FULL: PASS with suffix" "$FULL_PATTERN"
test_verdict "VERDICT: FAIL — gate 8 failed" "FAIL" "FULL: FAIL with suffix" "$FULL_PATTERN"
test_verdict "> VERDICT: PASS" "PASS" "FULL: quoted PASS" "$FULL_PATTERN"
test_verdict "## VERDICT: PASS" "PASS" "FULL: markdown heading PASS" "$FULL_PATTERN"
test_verdict "**VERDICT: PASS**" "PASS" "FULL: bold PASS" "$FULL_PATTERN"
test_verdict "VERDICT: PASS — merged" "PASS" "FULL: PASS with em-dash suffix" "$FULL_PATTERN"
test_verdict "VERDICT: PASSED" "" "FULL: PASSED rejected by \\b" "$FULL_PATTERN"
test_verdict "VERDICT: PASSING" "" "FULL: PASSING rejected by \\b" "$FULL_PATTERN"
test_verdict "VERDICT: FAILED" "" "FULL: FAILED rejected by \\b" "$FULL_PATTERN"
test_verdict "VERDICT: SKIPPING" "" "FULL: SKIPPING rejected by \\b" "$FULL_PATTERN"

# Multi-line bodies (using shell $'' for real newlines)
MULTI_PASS=$'<!-- skeptic-agent-verdict -->\n\nVERDICT: PASS\n\n--- Details ---'
MULTI_FAIL=$'<!-- skeptic-agent-verdict -->\n\nVERDICT: FAIL\n\n--- Full skeptic output ---'
# ^ anchor with m flag is jq-version-dependent; test with CORE_PATTERN for multi-line
# (FULL_PATTERN with ^ works on Ubuntu GHA runner but not macOS jq 1.7.1)
test_verdict "$MULTI_PASS" "PASS" "FULL: multi-line body PASS (core fallback)" "$CORE_PATTERN"
test_verdict "$MULTI_FAIL" "FAIL" "FULL: multi-line body FAIL (core fallback)" "$CORE_PATTERN"
# Verify ^ anchor works on single-line (should work on all jq versions)
test_verdict "VERDICT: PASS" "PASS" "FULL: single-line ^ anchor" "$FULL_PATTERN"

# === Tests using CORE_PATTERN (no ^ anchor, cross-platform jq compat) ===
echo ""
echo "--- Core pattern tests (no ^ anchor, cross-platform) ---"
test_verdict "VERDICT: PASS" "PASS" "CORE: simple PASS" "$CORE_PATTERN"
test_verdict "VERDICT: FAIL" "FAIL" "CORE: simple FAIL" "$CORE_PATTERN"
test_verdict "VERDICT: SKIPPED" "SKIPPED" "CORE: simple SKIPPED" "$CORE_PATTERN"
test_verdict "VERDICT: PASSED" "" "CORE: PASSED rejected by \\b" "$CORE_PATTERN"
test_verdict "VERDICT: PASSING" "" "CORE: PASSING rejected by \\b" "$CORE_PATTERN"
test_verdict "$MULTI_PASS" "PASS" "CORE: multi-line body PASS" "$CORE_PATTERN"
test_verdict "$MULTI_FAIL" "FAIL" "CORE: multi-line body FAIL" "$CORE_PATTERN"

# === Red-Green regression tests ===
echo ""
echo "--- Red-Green regression tests ---"
MULTI=$'VERDICT: PASS\n\n--- Details ---'
test_old_vs_new "$MULTI" "" "PASS" "multi-line body: old $ misses, new \\b matches"

# Intermediate pattern (removed $ but no \b) — allows partial matches
test_partial() {
  local body="$1" expected="$2" label="$3"
  INTERMEDIATE='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?'
  actual=$(jq -n --arg body "$body" --arg re "$INTERMEDIATE" \
    '$body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}
test_partial "VERDICT: PASSED" "PASS" "intermediate pattern (no $, no \\b) matches PASSED as PASS"
test_verdict "VERDICT: PASSED" "" "final pattern (\\b) rejects PASSED" "$CORE_PATTERN"

echo ""
echo "All VERDICT regex regression tests passed."
