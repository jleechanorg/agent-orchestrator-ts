#!/bin/bash
# verify-plist-substitution.sh
# TDD test: verifies GITHUB_TOKEN substitution in the lifecycle plist.
# RED: before the fix (template missing @GITHUB_TOKEN@), this test FAILS.
# GREEN: after the fix, this test PASSES.
#
# Run: bash scripts/__tests__/lifecycle-plist-substitution.test.sh
set -euo pipefail

TEMPLATE="launchd/ai.agento.lifecycle-all.plist.template"
SETUP_SCRIPT="scripts/setup-launchd.sh"
FAILED=0

echo "=== Plist substitution TDD test ==="

# 1. RED check: template must have @GITHUB_TOKEN@ placeholder
echo ""
echo "[1] Checking template has @GITHUB_TOKEN@ placeholder..."
if grep -q '@GITHUB_TOKEN@' "$TEMPLATE"; then
  echo "    PASS: template has @GITHUB_TOKEN@ placeholder"
else
  echo "    FAIL: template is missing @GITHUB_TOKEN@ placeholder"
  echo "    Without this, GITHUB_TOKEN never reaches workers → gh auth fails inside skeptic-cron"
  FAILED=1
fi

# 2. Verify setup-launchd.sh substitutes @GITHUB_TOKEN@ (not commented out)
echo ""
echo "[2] Checking setup-launchd.sh has UNCOMMENTED GITHUB_TOKEN substitution..."
# Must match a non-commented sed -e line with @GITHUB_TOKEN@ substitution
# The line looks like:     -e "s|@GITHUB_TOKEN@|$(escape_sed "${GITHUB_TOKEN:-}")|g" \
if grep -E '^\s+-e "s\|@GITHUB_TOKEN@\|.*escape_sed' "$SETUP_SCRIPT" >/dev/null 2>&1; then
  echo "    PASS: setup-launchd.sh has active GITHUB_TOKEN substitution"
else
  echo "    FAIL: setup-launchd.sh does not have @GITHUB_TOKEN@ substitution (or it's commented out)"
  echo "    Without this, GITHUB_TOKEN never reaches workers → gh auth fails in skeptic-cron"
  FAILED=1
fi

# 3. Verify the installed plist has a real GITHUB_TOKEN (not @VAR@, not empty)
echo ""
echo "[3] Verifying installed plist has a real GITHUB_TOKEN value..."
INSTALLED_PLIST="${HOME}/Library/LaunchAgents/ai.agento.lifecycle-all.plist"
if [ ! -f "$INSTALLED_PLIST" ]; then
  echo "    SKIP: no installed plist (run setup first: bash scripts/setup-launchd.sh lifecycle)"
elif grep -q '@GITHUB_TOKEN@' "$INSTALLED_PLIST"; then
  echo "    FAIL: installed plist still has @GITHUB_TOKEN@ — substitution never ran"
  echo "    This means workers get no GITHUB_TOKEN → gh auth fails inside skeptic-cron"
  FAILED=1
else
  gh_token_value=$(plutil -p "$INSTALLED_PLIST" 2>/dev/null | grep '"GITHUB_TOKEN"' | sed 's/.*=> "//;s/".*//' || true)
  if echo "$gh_token_value" | grep -q 'ghp_'; then
    echo "    PASS: installed plist has real GITHUB_TOKEN ($(echo "$gh_token_value" | sed 's/ghp_.*/ghp_***/'))"
  elif [ -z "$(echo "$gh_token_value" | tr -d ' \n')" ]; then
    echo "    FAIL: GITHUB_TOKEN key exists but value is empty"
    FAILED=1
  else
    echo "    PASS: GITHUB_TOKEN is present in installed plist: $(echo "$gh_token_value" | tr -d '\n')"
  fi
fi

echo ""
if [ $FAILED -eq 0 ]; then
  echo "=== ALL CHECKS PASSED ==="
  exit 0
else
  echo "=== TEST FAILED ==="
  echo "Without GITHUB_TOKEN in the plist, gh CLI fails inside lifecycle-worker:"
  echo "  → skeptic-cron lists PRs successfully but gh api calls fail with auth errors"
  echo "  → no VERDICT comments posted on PRs"
  echo ""
  echo "Fix: re-run bash scripts/setup-launchd.sh lifecycle"
  exit 1
fi
