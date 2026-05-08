#!/bin/bash
# Regression test: fractional-second timestamps work in test.yml grace-window check
# Validates the fix: [[:digit:]:.] instead of [[:digit:]:]
# GitHub API updated_at includes fractional seconds, e.g. 2026-05-08T09:19:09.757158Z

set -euo pipefail

REGEX='^[[:digit:]]{4}-[[:digit:]]{2}-[[:digit:]]{2}T[[:digit:]:.]+Z$'

pass_count=0
fail_count=0

test_timestamp() {
  local ts="$1"
  local expected="$2"
  local result
  result=$(printf '%s' "$ts" | grep -qE "$REGEX" 2>/dev/null && echo "match" || echo "no-match")
  if [ "$result" = "$expected" ]; then
    echo "  PASS: '$ts' => $result"
    pass_count=$((pass_count + 1))
  else
    echo "  FAIL: '$ts' => $result (expected $expected)"
    fail_count=$((fail_count + 1))
  fi
}

# Shell-agnostic: works on Linux (date -d) and macOS BSD (date -j -f)
to_epoch() {
  local stripped="${1%.*}"      # remove .fractional
  local spaced="${stripped/T/ }" # replace T with space
  # Linux: GNU date -d; BSD: date -j -f
  date -d "$spaced" +%s 2>/dev/null || \
    date -j -f "%Y-%m-%d %H:%M:%S" "$spaced" +%s 2>/dev/null || \
    echo "0"
}

echo "=== Fractional-second timestamp regex tests ==="

# Fractional second variants (main fix)
test_timestamp "2026-05-08T09:19:09.757158Z" "match"
test_timestamp "2026-05-08T09:19:09.7Z" "match"
test_timestamp "2026-05-08T09:19:09.123456789Z" "match"

# Standard (no fractional seconds)
test_timestamp "2026-05-08T09:19:09Z" "match"

# Edge: single digit after dot is valid
test_timestamp "2026-05-08T09:19:09.3Z" "match"

echo ""
echo "=== Epoch conversion test ==="

ts="2026-05-08T09:19:09.757158Z"
epoch=$(to_epoch "$ts")
if [ "$epoch" -gt 0 ]; then
  echo "  PASS: '$ts' => epoch $epoch"
  pass_count=$((pass_count + 1))
else
  echo "  FAIL: '$ts' => epoch $epoch (expected > 0)"
  fail_count=$((fail_count + 1))
fi

echo ""
echo "=== Grace window calculation test ==="

# Verdict posted 3 min before trigger should be accepted
trigger_ts="2026-05-08T09:19:00.000000Z"
verdict_ts="2026-05-08T09:16:00.000000Z"  # 3 min before
GRACE_SECS=300

trigger_epoch=$(to_epoch "$trigger_ts")
verdict_epoch=$(to_epoch "$verdict_ts")
grace_start=$((trigger_epoch - GRACE_SECS))

if [ "$verdict_epoch" -gt 0 ] && [ "$verdict_epoch" -ge "$grace_start" ]; then
  echo "  PASS: verdict at T-$(((trigger_epoch - verdict_epoch) / 60))m accepted (>= grace_start)"
  pass_count=$((pass_count + 1))
else
  echo "  FAIL: verdict rejected when it should be accepted (verdict=$verdict_epoch, grace_start=$grace_start)"
  fail_count=$((fail_count + 1))
fi

# Stale verdict: 10 min before trigger should be rejected
verdict_ts_stale="2026-05-08T09:09:00.000000Z"
verdict_epoch_stale=$(to_epoch "$verdict_ts_stale")
if [ "$verdict_epoch_stale" -gt 0 ] && [ "$verdict_epoch_stale" -lt "$grace_start" ]; then
  echo "  PASS: stale verdict at T-$(((trigger_epoch - verdict_epoch_stale) / 60))m correctly rejected"
  pass_count=$((pass_count + 1))
else
  echo "  FAIL: stale verdict NOT rejected (verdict=$verdict_epoch_stale, grace_start=$grace_start)"
  fail_count=$((fail_count + 1))
fi

echo ""
echo "=== Summary ==="
echo "Passed: $pass_count"
echo "Failed: $fail_count"

if [ "$fail_count" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi