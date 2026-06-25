#!/usr/bin/env bash
# Unit test for routing AO logs to ~/.hermes/logs instead of ~/.openclaw/logs
#
# Run: bash tests/unit/test-log-paths.sh

set -euo pipefail

PASS=0; FAIL=0; XFAIL=0

run_check() {
  local label="$1" file="$2"
  # We search for any reference to .openclaw/logs in the file.
  # The RED run expects the file to contain .openclaw/logs.
  # The GREEN run expects the file to NOT contain .openclaw/logs (instead using .hermes/logs).
  if grep -q "\.openclaw/logs" "$file"; then
    printf "  FAIL  %s\n        Found '.openclaw/logs' reference in %s\n" "$label" "$file"
    FAIL=$((FAIL+1))
  else
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS+1))
  fi
}

run_xfail() {
  local label="$1" file="$2"
  if grep -q "\.openclaw/logs" "$file"; then
    printf "  XFAIL %s\n        Found expected legacy '.openclaw/logs' reference in %s\n" "$label" "$file"
    XFAIL=$((XFAIL+1))
  else
    printf "  PASS  %s (bug fixed)\n" "$label"
    PASS=$((PASS+1))
  fi
}

echo ""
echo "=== RED: broken version (demonstrates the legacy log paths) ==="
run_xfail "ao-health.sh uses legacy log path" "scripts/ao-health.sh"
run_xfail "health-guardian.sh uses legacy log path" "scripts/ai.agento.health-guardian.sh"
run_xfail "start-all.sh uses legacy log path" "scripts/start-all.sh"
run_xfail "ensure-top-pr-coverage.sh uses legacy log path" "scripts/ensure-top-pr-coverage.sh"
run_xfail "check-pr-worker-coverage.sh uses legacy log path" "scripts/check-pr-worker-coverage.sh"
run_xfail "hermes-watchdog.sh uses legacy log path" "scripts/hermes-watchdog.sh"
run_xfail "lw-watchdog.sh uses legacy log path" "scripts/lw-watchdog.sh"
run_xfail "setup-antigravity-launchd.sh uses legacy log path" "scripts/setup-antigravity-launchd.sh"

echo ""
echo "=== GREEN: fixed version (checks after fix) ==="
run_check "ao-health.sh should use hermes/logs" "scripts/ao-health.sh"
run_check "health-guardian.sh should use hermes/logs" "scripts/ai.agento.health-guardian.sh"
run_check "start-all.sh should use hermes/logs" "scripts/start-all.sh"
run_check "ensure-top-pr-coverage.sh should use hermes/logs" "scripts/ensure-top-pr-coverage.sh"
run_check "check-pr-worker-coverage.sh should use hermes/logs" "scripts/check-pr-worker-coverage.sh"
run_check "hermes-watchdog.sh should use hermes/logs" "scripts/hermes-watchdog.sh"
run_check "lw-watchdog.sh should use hermes/logs" "scripts/lw-watchdog.sh"
run_check "setup-antigravity-launchd.sh should use hermes/logs" "scripts/setup-antigravity-launchd.sh"

echo ""
echo "Results: PASS=$PASS XFAIL=$XFAIL FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "All checks run. (If this is the RED run, XFAIL=$XFAIL and FAIL=$FAIL is expected. If this is the GREEN run, PASS should be 16)."
  exit 0
else
  echo "FAILURES DETECTED: $FAIL checks failed."
  exit 1
fi
