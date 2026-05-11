#!/usr/bin/env bash
# Regression tests for VERDICT capture regex in skeptic-cron-reusable.yml,
# skeptic-gate-reusable.yml, and test.yml.
# Exercises the jq capture pattern against known positive and negative cases.
# NOTE: ^ anchor with m flag is jq-version-dependent (works on Ubuntu GHA runner,
# may not work on macOS jq 1.7.1). Tests use JSON body format (matching the workflow).
set -euo pipefail

pass() { echo "OK: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Core capture pattern (without ^ anchor — ^ with m flag is jq-version-dependent)
CAPTURE_PATTERN='(?<verdict>PASS|FAIL|SKIPPED)\b'
# Full pattern as used in the workflow YAML (with ^ anchor)
FULL_PATTERN='^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)\b(?:\*{1,2})?[ \t]*(?:[-—:][^\n]*)?'

# Test using JSON body format (how the workflow receives data from gh api)
# This avoids jq -R --slurp issues with ^ on different jq versions
test_verdict_json() {
  local body="$1" expected="$2" label="$3"
  # Construct JSON with body, pipe through jq with capture pattern
  actual=$(printf '%s' "$body" | jq -R --slurp --arg re "$CAPTURE_PATTERN" \
    '{body: .} | .body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# Test the old broken pattern ($ anchor) vs new pattern (word boundary)
test_old_vs_new() {
  local body="$1" old_expected="$2" new_expected="$3" label="$4"
  # Patterns include VERDICT: prefix to test partial-match behavior
  OLD_PATTERN='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$'
  NEW_PATTERN='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)\b(?:\*{1,2})?[ \t]*(?:[-—:][^\n]*)?'

  old_actual=$(printf '%s' "$body" | jq -R --slurp --arg re "$OLD_PATTERN" \
    '{body: .} | .body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')
  new_actual=$(printf '%s' "$body" | jq -R --slurp --arg re "$NEW_PATTERN" \
    '{body: .} | .body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')

  old_ok="OK"; new_ok="OK"
  [ "$old_actual" = "$old_expected" ] || old_ok="FAIL(got '$old_actual')"
  [ "$new_actual" = "$new_expected" ] || new_ok="FAIL(got '$new_actual')"
  echo "RED-GREEN $label: old=$old_ok new=$new_ok"
  [ "$old_actual" = "$old_expected" ] && [ "$new_actual" = "$new_expected" ] || \
    fail "$label — old expected '$old_expected' got '$old_actual', new expected '$new_expected' got '$new_actual'"
}

# --- Positive cases (should match) ---
test_verdict_json "VERDICT: PASS" "PASS" "simple PASS"
test_verdict_json "VERDICT: FAIL" "FAIL" "simple FAIL"
test_verdict_json "VERDICT: SKIPPED" "SKIPPED" "simple SKIPPED"
test_verdict_json "VERDICT: PASS — all gates green" "PASS" "PASS with suffix"
test_verdict_json "VERDICT: FAIL — gate 8 failed" "FAIL" "FAIL with suffix"
test_verdict_json "> VERDICT: PASS" "PASS" "quoted PASS"
test_verdict_json "## VERDICT: PASS" "PASS" "markdown heading PASS"
test_verdict_json "**VERDICT: PASS**" "PASS" "bold PASS"
test_verdict_json "VERDICT: PASS — merged" "PASS" "PASS with em-dash suffix"

# Multi-line bodies (real newlines via $'' syntax)
MULTI_PASS=$'<!-- skeptic-agent-verdict -->\n\nVERDICT: PASS\n\n--- Details ---'
MULTI_FAIL=$'<!-- skeptic-agent-verdict -->\n\nVERDICT: FAIL\n\n--- Full skeptic output ---'
test_verdict_json "$MULTI_PASS" "PASS" "multi-line body PASS"
test_verdict_json "$MULTI_FAIL" "FAIL" "multi-line body FAIL"

# --- Negative cases (should NOT match) ---
test_verdict_json "VERDICT: PASSED" "" "PASSED should not match as PASS"
test_verdict_json "VERDICT: PASSING" "" "PASSING should not match as PASS"
test_verdict_json "VERDICT: FAILED" "" "FAILED should not match as FAIL"
test_verdict_json "VERDICT: SKIPPING" "" "SKIPPING should not match as SKIPPED"
test_verdict_json "" "" "empty body"

# --- Red-Green regression tests (old $ anchor vs new \b word boundary) ---
# These prove the specific bug this PR fixes:
# 1. $ anchor fails on multi-line bodies (main bug)
# 2. Without $ but without \b, partial matches occur (secondary bug)
MULTI=$'VERDICT: PASS\n\n--- Details ---'
test_old_vs_new "$MULTI" "" "PASS" "multi-line body: old $ misses, new \\b matches"
# For partial match test, use a pattern WITHOUT $ (the intermediate state after removing $
# but before adding \b) to show the partial-match regression that \b prevents
test_partial() {
  local body="$1" expected="$2" label="$3"
  # Intermediate pattern (removed $ but no \b) — allows partial matches
  INTERMEDIATE='VERDICT:[ \t]*(?<verdict>PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?'
  actual=$(printf '%s' "$body" | jq -R --slurp --arg re "$INTERMEDIATE" \
    '{body: .} | .body as $b | try ($b | capture($re; "im").verdict | ascii_upcase) catch ""' 2>/dev/null | tr -d '"')
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}
test_partial "VERDICT: PASSED" "PASS" "intermediate pattern (no $, no \\b) matches PASSED as PASS"
test_verdict_json "VERDICT: PASSED" "" "final pattern (\\b) rejects PASSED"

echo ""
echo "All VERDICT regex regression tests passed."
