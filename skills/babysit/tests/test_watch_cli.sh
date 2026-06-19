#!/usr/bin/env bash
# test_watch_cli.sh — validates watch_worker.sh CLI argument handling and
# PR extraction logic (via --pr-extract-test shim).
# Run: bash tests/test_watch_cli.sh
# Pass criterion: 10/10 tests pass
set -euo pipefail

SCRIPT="$(dirname "$0")/../bin/watch_worker.sh"
PASS=0; FAIL=0

check() {
  local label="$1" expected_exit="$2"; shift 2
  local output exit_code=0
  output=$(bash "$SCRIPT" "$@" 2>&1) || exit_code=$?
  if [[ $exit_code -eq $expected_exit ]]; then
    echo "  PASS: $label (exit $exit_code)"
    ((PASS++)) || true
  else
    echo "  FAIL: $label — expected exit $expected_exit, got $exit_code"
    echo "    output: $output"
    ((FAIL++)) || true
  fi
}

check_output() {
  local label="$1" pattern="$2"; shift 2
  local output
  output=$(bash "$SCRIPT" "$@" 2>&1) || true
  if echo "$output" | grep -q "$pattern"; then
    echo "  PASS: $label (output matches '$pattern')"
    ((PASS++)) || true
  else
    echo "  FAIL: $label — expected '$pattern' in output"
    echo "    output: $output"
    ((FAIL++)) || true
  fi
}

echo "WATCH-CLI validation tests"

# --poll-sec 0 rejected (hot loop prevention)
check "--poll-sec 0 rejected" 2 --poll-sec 0
check_output "--poll-sec 0 error message" "positive integer" --poll-sec 0

# --poll-sec with non-integer rejected
check "--poll-sec abc rejected" 2 --poll-sec abc

# --poll-sec without value rejected
check "--poll-sec (no value) rejected" 2 --poll-sec

# --max-min without value rejected
check "--max-min (no value) rejected" 2 --max-min

# --max-min with non-integer rejected
check "--max-min abc rejected" 2 --max-min abc

# Duplicate positional argument rejected
check "duplicate session arg rejected" 2 session1 session2
check_output "duplicate session error message" "only one session" session1 session2

# PR extraction behavioral tests — exercise watch_worker.sh's actual grep-oE
# command via the --pr-extract-test shim (same code path as line 133 in the loop).
check_extract() {
  local label="$1" input="$2" expected="$3"
  local result exit_code=0
  result=$(echo "$input" | bash "$SCRIPT" --pr-extract-test 2>&1) || exit_code=$?
  if [[ "$result" == "$expected" ]]; then
    echo "  PASS: $label (got '$result')"
    ((PASS++)) || true
  else
    echo "  FAIL: $label — expected '$expected', got '$result'"
    ((FAIL++)) || true
  fi
}
check_extract "PR #123 format extracted" "PR #123 | ctx ###------ 40%" "PR #123"
check_extract "PR: #123 format extracted" "PR: #123 | ctx ###------ 40%" "PR: #123"

echo "WATCH-CLI: $([[ $FAIL -eq 0 ]] && echo PASS || echo FAIL) ($PASS/$((PASS+FAIL)))"
[[ $FAIL -eq 0 ]]
