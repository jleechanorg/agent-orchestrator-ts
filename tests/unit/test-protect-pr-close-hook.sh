#!/usr/bin/env bash
# Unit tests for .claude/hooks/protect-pr-close.sh
#
# Run: bash tests/unit/test-protect-pr-close-hook.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$SCRIPT_DIR/.claude/hooks/protect-pr-close.sh"

PASS=0
FAIL=0

assert_success() {
  local label="$1"
  local payload="$2"
  local stdout_file stderr_file rc
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  if bash "$HOOK" <<<"$payload" >"$stdout_file" 2>"$stderr_file"; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    rc=$?
    printf "  FAIL  %s\n        rc: %s\n" "$label" "$rc"
    printf "        stdout: %s\n" "$(cat "$stdout_file")"
    printf "        stderr: %s\n" "$(cat "$stderr_file")"
    FAIL=$((FAIL + 1))
  fi

  rm -f "$stdout_file" "$stderr_file"
}

echo ""
echo "=== protect-pr-close hook ==="

assert_success \
  "allows harmless bash command" \
  '{"tool_name":"Bash","tool_input":{"command":"git -C /tmp/nope branch --show-current"}}'

assert_success \
  "ignores gh pr close text inside heredoc body" \
  '{"tool_name":"Bash","tool_input":{"command":"cat <<'\''EOF'\''\ngh pr close 123\nEOF\nprintf done\n"}}'

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "OK — protect-pr-close hook stays non-blocking for non-close commands."
  exit 0
fi

echo "UNEXPECTED — protect-pr-close hook regression detected."
exit 1
