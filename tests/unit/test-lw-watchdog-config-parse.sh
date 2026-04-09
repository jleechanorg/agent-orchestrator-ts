#!/usr/bin/env bash
# Regression tests for config-parse failure handling in scripts/lw-watchdog.sh
#
# Run: bash tests/unit/test-lw-watchdog-config-parse.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG_SCRIPT="$SCRIPT_DIR/scripts/lw-watchdog.sh"

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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n        missing: %s\n" "$label" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

extract_function() {
  local start="$1" end="$2"
  sed -n "/^${start}()/,/^${end}()/p" "$WATCHDOG_SCRIPT" | sed '$d'
}

CONFIG_PARSE_FAILED_SENTINEL="__CONFIG_PARSE_FAILED__"

eval "$(extract_function list_missing_lifecycle_workers has_exact_lifecycle_worker_for_project)"

list_configured_projects() {
  printf '%s\n' "$CONFIG_PARSE_FAILED_SENTINEL"
}

has_exact_lifecycle_worker_for_project() {
  return 1
}

echo ""
echo "=== config parse sentinel propagation ==="
assert_eq "parse failure stays explicit" \
  "$(list_missing_lifecycle_workers)" \
  "$CONFIG_PARSE_FAILED_SENTINEL"

caller_block="$(sed -n '/STATE_CLASS" = "not_running"/,/log "RESTART_NEEDED:/p' "$WATCHDOG_SCRIPT")"

echo ""
echo "=== caller handling ==="
assert_contains "caller checks parse failure sentinel" \
  "$caller_block" \
  '"$MISSING_WORKERS" = "$CONFIG_PARSE_FAILED_SENTINEL"'

assert_contains "caller still preserves healthy dormant branch" \
  "$caller_block" \
  'log "HEALTHY_DORMANT: $SERVICE_ID — wrapper not running, all child lifecycle workers present"'

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "OK — watchdog preserves config-parse failures instead of misclassifying them as healthy dormant."
  exit 0
fi

echo "UNEXPECTED — watchdog config-parse regression detected."
exit 1
