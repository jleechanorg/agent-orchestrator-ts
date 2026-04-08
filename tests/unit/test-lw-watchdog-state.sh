#!/usr/bin/env bash
# Unit tests for scripts/lib/launchd-service-state.sh
#
# Run: bash tests/unit/test-lw-watchdog-state.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/scripts/lib/launchd-service-state.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" got="$2" expected="$3"
  if [[ "$got" == "$expected" ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n        got:      %s\n        expected: %s\n" \
      "$label" "$got" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

running_output='gui/501/ai.agento.lifecycle-all = {
	active count = 1
	state = running
}'

not_running_output='gui/501/ai.agento.lifecycle-all = {
	active count = 0
	state = not running
}'

waiting_output='gui/501/ai.agento.lifecycle-all = {
	state = waiting
}'

spawn_output='gui/501/ai.agento.lifecycle-all = {
	state = spawn scheduled
}'

missing_output='Bad request.
Could not find service "ai.agento.lifecycle-all" in domain for user gui: 501'

echo ""
echo "=== launchctl state parsing ==="
assert_eq "extract running" \
  "$(extract_launchctl_state_from_output "$running_output")" \
  "running"
assert_eq "extract not running keeps both words" \
  "$(extract_launchctl_state_from_output "$not_running_output")" \
  "not running"
assert_eq "extract waiting" \
  "$(extract_launchctl_state_from_output "$waiting_output")" \
  "waiting"
assert_eq "extract missing service" \
  "$(extract_launchctl_state_from_output "$missing_output")" \
  "not_found"

echo ""
echo "=== launchctl state classification ==="
assert_eq "classify running" \
  "$(classify_launchctl_state "running")" \
  "running"
assert_eq "classify not running" \
  "$(classify_launchctl_state "not running")" \
  "not_running"
assert_eq "classify waiting" \
  "$(classify_launchctl_state "waiting")" \
  "waiting"
assert_eq "classify spawn scheduled" \
  "$(classify_launchctl_state "$(extract_launchctl_state_from_output "$spawn_output")")" \
  "spawn_pending"
assert_eq "classify missing service" \
  "$(classify_launchctl_state "not_found")" \
  "not_found"

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "OK — launchctl state parsing handles not running, waiting, spawn, and missing-service cases."
  exit 0
fi

echo "UNEXPECTED — watchdog state parser regression detected."
exit 1
