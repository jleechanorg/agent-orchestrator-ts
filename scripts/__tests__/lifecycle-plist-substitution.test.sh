#!/bin/bash
# RED/GREEN TDD test for GITHUB_TOKEN and CLAUDE_BINARY plist substitution.
# Run: bash scripts/__tests__/lifecycle-plist-substitution.test.sh
#
# Check 1: template has @GITHUB_TOKEN@ placeholder
# Check 2: setup script has uncommented sed substitution for @GITHUB_TOKEN@
# Check 3: installed plist has real ghp_ token (not empty or @GITHUB_TOKEN@)
# Check 4: template has @CLAUDE_BINARY@ placeholder
# Check 5: setup script has uncommented sed substitution for @CLAUDE_BINARY@
# Check 6: installed plist has non-empty, non-placeholder CLAUDE_BINARY

set -euo pipefail

FAILED=0
TEMPLATE="launchd/ai.agento.lifecycle-all.plist.template"
SETUP_SCRIPT="scripts/setup-launchd.sh"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/ai.agento.lifecycle-all.plist"

mask_secret() {
  local v="${1:-}"
  if [ -z "$v" ]; then
    printf '%s' "<empty>"
  else
    printf '%s' "${v:0:4}***"
  fi
}

echo "=== Plist substitution TDD test ==="

# Check 1-3: GITHUB_TOKEN — skip gracefully if removed from template (optional var)
if [ -f "$TEMPLATE" ] && grep -q '@GITHUB_TOKEN@' "$TEMPLATE"; then
  echo -n "Check 1: template has @GITHUB_TOKEN@... PASS"
  echo ""
  echo -n "Check 2: setup script has sed substitution for @GITHUB_TOKEN@... "
  if grep -E '^[[:space:]]+-e "s\|@GITHUB_TOKEN@\|.*escape_sed.*\|g"' "$SETUP_SCRIPT" >/dev/null 2>&1; then
    echo "PASS"
  else
    echo "FAIL — sed substitution line missing or commented out in $SETUP_SCRIPT"
    FAILED=1
  fi
  echo -n "Check 3: installed plist has a real token... "
  if [ -f "$INSTALLED_PLIST" ]; then
    gh_token_value=$(plutil -p "$INSTALLED_PLIST" 2>/dev/null | grep '"GITHUB_TOKEN"' | sed 's/.*=> "//;s/".*//' || true)
    gh_token_value_trimmed="${gh_token_value#"${gh_token_value%%[![:space:]]*}"}"
    gh_token_value_trimmed="${gh_token_value_trimmed%"${gh_token_value_trimmed##*[![:space:]]}"}"
    if [ -z "$gh_token_value_trimmed" ]; then
      echo "FAIL — GITHUB_TOKEN is empty in installed plist"
      FAILED=1
    elif echo "$gh_token_value_trimmed" | grep -q '@'; then
      echo "FAIL — GITHUB_TOKEN is unsubstituted @VAR@ in installed plist"
      FAILED=1
    else
      echo "PASS (masked: $(mask_secret "$gh_token_value_trimmed"))"
    fi
  else
    echo "SKIP — installed plist not found (may need install first)"
  fi
else
  echo "Check 1-3: GITHUB_TOKEN not in template — SKIP (removed upstream)"
fi

# Check 4: Template has @CLAUDE_BINARY@ placeholder
echo -n "Check 4: template has @CLAUDE_BINARY@... "
if [ -f "$TEMPLATE" ] && grep -q '@CLAUDE_BINARY@' "$TEMPLATE"; then
  echo "PASS"
else
  echo "FAIL — @CLAUDE_BINARY@ not found in $TEMPLATE"
  FAILED=1
fi

# Check 5: Setup script has uncommented sed substitution for CLAUDE_BINARY
echo -n "Check 5: setup script has sed substitution for @CLAUDE_BINARY@... "
if grep -E '^[[:space:]]+-e "s\|@CLAUDE_BINARY@\|.*escape_sed.*\|g"' "$SETUP_SCRIPT" >/dev/null 2>&1; then
  echo "PASS"
else
  echo "FAIL — sed substitution line missing, commented out, or missing escape_sed in $SETUP_SCRIPT"
  echo "  Expected: -e \"s|@CLAUDE_BINARY@|\$(escape_sed ...)|g\""
  FAILED=1
fi

# Check 6: Installed plist has a real CLAUDE_BINARY value (not placeholder, not empty)
echo -n "Check 6: installed plist has a real CLAUDE_BINARY value... "
if [ -f "$INSTALLED_PLIST" ]; then
  claude_bin_value=$(plutil -p "$INSTALLED_PLIST" 2>/dev/null | grep '"CLAUDE_BINARY"' | sed 's/.*=> "//;s/".*//' || true)
  claude_bin_trimmed="${claude_bin_value#"${claude_bin_value%%[![:space:]]*}"}"
  claude_bin_trimmed="${claude_bin_trimmed%"${claude_bin_trimmed##*[![:space:]]}"}"
  if [ -z "$claude_bin_trimmed" ]; then
    echo "FAIL — CLAUDE_BINARY is empty in installed plist"
    FAILED=1
  elif echo "$claude_bin_trimmed" | grep -q '@'; then
    echo "FAIL — CLAUDE_BINARY is unsubstituted @VAR@ in installed plist"
    FAILED=1
  else
    echo "PASS (${claude_bin_trimmed})"
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