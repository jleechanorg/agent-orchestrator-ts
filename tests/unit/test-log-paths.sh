#!/usr/bin/env bash
# Unit test for routing AO logs to ~/.hermes/logs instead of ~/.openclaw/logs
#
# Run: bash tests/unit/test-log-paths.sh

set -euo pipefail

PASS=0; FAIL=0; XFAIL=0

run_check() {
  local label="$1" file="$2"
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

run_setup_launchd_check() {
  local label="$1" file="$2"
  # setup-launchd.sh has comments mentioning .openclaw/logs, so we check the BASE_LOG_DIR assignment specifically
  if grep -q 'BASE_LOG_DIR=.*\.openclaw/logs' "$file"; then
    printf "  FAIL  %s\n        Found legacy BASE_LOG_DIR assignment in %s\n" "$label" "$file"
    FAIL=$((FAIL+1))
  else
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS+1))
  fi
}

run_setup_launchd_xfail() {
  local label="$1" file="$2"
  if grep -q 'BASE_LOG_DIR=.*\.openclaw/logs' "$file"; then
    printf "  XFAIL %s\n        Found expected legacy BASE_LOG_DIR assignment in %s\n" "$label" "$file"
    XFAIL=$((XFAIL+1))
  else
    printf "  PASS  %s (bug fixed)\n" "$label"
    PASS=$((PASS+1))
  fi
}

run_bootstrap_check() {
  local label="$1" file="$2"
  # bootstrap-openclaw-config.sh must ensure .hermes/logs and must NOT contain .openclaw/logs
  if ! grep -q "\.hermes/logs" "$file" || ! grep -q "\.hermes_prod/logs" "$file"; then
    printf "  FAIL  %s\n        Missing .hermes/logs initialization in %s\n" "$label" "$file"
    FAIL=$((FAIL+1))
  elif grep -q "\.openclaw/logs" "$file"; then
    printf "  FAIL  %s\n        Found unexpected legacy '.openclaw/logs' reference in %s\n" "$label" "$file"
    FAIL=$((FAIL+1))
  else
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS+1))
  fi
}

run_bootstrap_xfail() {
  local label="$1" file="$2"
  if ! grep -q "\.hermes/logs" "$file" || ! grep -q "\.hermes_prod/logs" "$file" || grep -q "\.openclaw/logs" "$file"; then
    printf "  XFAIL %s\n        Found expected legacy setup in %s\n" "$label" "$file"
    XFAIL=$((XFAIL+1))
  else
    printf "  PASS  %s (bug fixed)\n" "$label"
    PASS=$((PASS+1))
  fi
}

run_template_check() {
  local label="$1" file="$2"
  # Plist templates use XML string elements. Ensure no hardcoded StandardOutPath/StandardErrorPath string points to .openclaw/logs
  if grep -E -q "<string>[^<]*\.openclaw/logs[^<]*</string>" "$file"; then
    printf "  FAIL  %s\n        Found hardcoded legacy log path string in template: %s\n" "$label" "$file"
    FAIL=$((FAIL+1))
  else
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS+1))
  fi
}

run_template_xfail() {
  local label="$1" file="$2"
  if grep -E -q "<string>[^<]*\.openclaw/logs[^<]*</string>" "$file"; then
    printf "  XFAIL %s\n        Found expected hardcoded legacy log path string in template: %s\n" "$label" "$file"
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
run_xfail "setup-extended.sh uses legacy log path" "scripts/setup-extended.sh"
run_setup_launchd_xfail "setup-launchd.sh has legacy BASE_LOG_DIR" "scripts/setup-launchd.sh"
run_bootstrap_xfail "bootstrap-openclaw-config.sh missing hermes logs" "scripts/bootstrap-openclaw-config.sh"

run_template_xfail "health-guardian template uses hardcoded log path" "launchd/ai.agento.health-guardian.plist.template"
run_template_check "health template uses placeholder" "launchd/ai.agento.health.plist.template"
run_template_check "novel-daily template uses placeholder" "launchd/ai.agento.novel-daily.plist.template"
run_template_check "antigravity-orch template uses placeholder" "launchd/ai.agento.antigravity-orch.plist.template"
run_template_check "lifecycle-all template uses placeholder" "launchd/ai.agento.lifecycle-all.plist.template"
run_template_check "lw-watchdog template uses placeholder" "launchd/ai.agento.lw-watchdog.plist.template"
run_template_check "drift-audit template uses placeholder" "launchd/ai.hermes.launchd-drift-audit.plist.template"

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
run_check "setup-extended.sh should use hermes/logs" "scripts/setup-extended.sh"
run_setup_launchd_check "setup-launchd.sh should use hermes/logs" "scripts/setup-launchd.sh"
run_bootstrap_check "bootstrap-openclaw-config.sh should set up hermes logs" "scripts/bootstrap-openclaw-config.sh"

run_template_check "health-guardian template should use placeholder" "launchd/ai.agento.health-guardian.plist.template"
run_template_check "health template should use placeholder" "launchd/ai.agento.health.plist.template"
run_template_check "novel-daily template should use placeholder" "launchd/ai.agento.novel-daily.plist.template"
run_template_check "antigravity-orch template should use placeholder" "launchd/ai.agento.antigravity-orch.plist.template"
run_template_check "lifecycle-all template should use placeholder" "launchd/ai.agento.lifecycle-all.plist.template"
run_template_check "lw-watchdog template should use placeholder" "launchd/ai.agento.lw-watchdog.plist.template"
run_template_check "drift-audit template should use placeholder" "launchd/ai.hermes.launchd-drift-audit.plist.template"

echo ""
echo "Results: PASS=$PASS XFAIL=$XFAIL FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "All checks run successfully."
  exit 0
else
  echo "FAILURES DETECTED: $FAIL checks failed."
  exit 1
fi
