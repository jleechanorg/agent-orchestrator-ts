#!/bin/bash
# RED/GREEN TDD test for GITHUB_TOKEN plist substitution.
# Run: bash scripts/__tests__/lifecycle-plist-substitution.test.sh
#
# Check 1: template has @GITHUB_TOKEN@ placeholder
# Check 2: setup script has uncommented sed substitution for @GITHUB_TOKEN@
# Check 3: installed plist has real ghp_ token (not empty or @GITHUB_TOKEN@)

set -euo pipefail

FAILED=0
TEMPLATE="launchd/ai.agento.lifecycle-all.plist.template"
SETUP_SCRIPT="scripts/setup-launchd.sh"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/ai.agento.lifecycle-all.plist"

echo "=== GITHUB_TOKEN plist substitution TDD test ==="

# Check 1: Template has @GITHUB_TOKEN@ placeholder
echo -n "Check 1: template has @GITHUB_TOKEN@... "
if [ -f "$TEMPLATE" ] && grep -q '@GITHUB_TOKEN@' "$TEMPLATE"; then
  echo "PASS"
else
  echo "FAIL — @GITHUB_TOKEN@ not found in $TEMPLATE"
  FAILED=1
fi

# Check 2: Setup script has uncommented sed substitution
# Must match: whitespace then -e then "s|@GITHUB_TOKEN@|
echo -n "Check 2: setup script has sed substitution for @GITHUB_TOKEN@... "
if grep -E '^\s+-e "s\|@GITHUB_TOKEN@\|.*escape_sed' "$SETUP_SCRIPT" >/dev/null 2>&1; then
  echo "PASS"
else
  echo "FAIL — sed substitution line missing or commented out in $SETUP_SCRIPT"
  echo "  Expected: -e \"s|@GITHUB_TOKEN@|\$(escape_sed ...)|g\""
  FAILED=1
fi

# Check 3: Installed plist has real token (not placeholder, not empty)
echo -n "Check 3: installed plist has ghp_ token... "
if [ -f "$INSTALLED_PLIST" ]; then
  gh_token_value=$(plutil -p "$INSTALLED_PLIST" 2>/dev/null | grep '"GITHUB_TOKEN"' | sed 's/.*=> "//;s/".*//' || true)
  if echo "$gh_token_value" | grep -q 'ghp_'; then
    echo "PASS (token length: ${#gh_token_value})"
  elif [ -z "$gh_token_value" ]; then
    echo "FAIL — GITHUB_TOKEN is empty in installed plist"
    FAILED=1
  elif echo "$gh_token_value" | grep -q '@'; then
    echo "FAIL — GITHUB_TOKEN is unsubstituted @VAR@ in installed plist"
    FAILED=1
  else
    echo "FAIL — GITHUB_TOKEN present but wrong format: ${gh_token_value:0:10}..."
    FAILED=1
  fi
else
  echo "SKIP — installed plist not found (may need install first)"
fi

if [ $FAILED -eq 0 ]; then
  echo ""
  echo "All checks PASSED"
  exit 0
else
  echo ""
  echo "FAILED — fix required"
  exit 1
fi