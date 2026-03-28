#!/bin/bash
# protect-pr-close.sh — PreToolUse hook
# Blocks `gh pr close` and `gh api .../pulls/N --method PATCH -f state=closed` commands.
# Agents must NEVER close PRs — only humans may close PRs manually.
# Created 2026-03-28 after bd-ewoj: 4 PRs closed by AO workers violating agentRules.
#
# Fail-closed: if python3 is unavailable or JSON is unparseable, BLOCK commands containing 'close'.

set -euo pipefail

INPUT=$(cat)

# Fail closed: if python3 is absent, block all Bash tool calls containing 'pr close' or 'state=closed'
if ! command -v python3 >/dev/null 2>&1; then
  if echo "$INPUT" | grep -qiE 'pr.close|state.*closed'; then
    echo "BLOCKED: python3 unavailable — cannot safely parse command. Never close PRs from agent sessions." >&2
    exit 2
  fi
  exit 0
fi

TOOL=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_name', ''))
except Exception:
    print('PARSE_ERROR')
" 2>/dev/null)

# If JSON parse failed, fail closed only if input contains PR close patterns
if [ "$TOOL" = "PARSE_ERROR" ]; then
  if echo "$INPUT" | grep -qiE 'pr.close|state.*closed'; then
    echo "BLOCKED: JSON parse error — cannot safely evaluate command that may close a PR." >&2
    exit 2
  fi
  exit 0
fi

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    print('PARSE_ERROR')
" 2>/dev/null)

if [ "$CMD" = "PARSE_ERROR" ]; then
  echo "BLOCKED: JSON parse error — cannot safely evaluate Bash command." >&2
  exit 2
fi

# Use Python to detect PR close commands
RESULT=$(python3 - "$CMD" <<'PYEOF'
import sys, re

cmd = sys.argv[1]

# Remove heredoc bodies
cmd_clean = re.sub(r'<<[-]?["\']?\w+["\']?.*?^\w+$', '', cmd, flags=re.DOTALL|re.MULTILINE)
# Remove double-quoted strings (but save for state=closed check)
cmd_for_token = re.sub(r'"[^"]*"', '""', cmd_clean)
# Remove single-quoted strings
cmd_for_token = re.sub(r"'[^']*'", "''", cmd_for_token)

# Use the cleaned version (quoted strings removed) to avoid false positives
# from commit messages, heredocs, etc. that mention "gh pr close" as text.
# Check 1: `gh pr close` as an actual command (not inside quotes)
if re.search(r'\bgh\s+pr\s+close\b', cmd_for_token, re.IGNORECASE):
    print('BLOCKED_GH_PR_CLOSE')
    sys.exit(0)

# Check 2: `gh api ... --method PATCH -f state=closed` (REST API close)
if re.search(r'\bgh\s+api\b.*pulls.*state.*closed', cmd_for_token, re.IGNORECASE):
    print('BLOCKED_GH_API_CLOSE')
    sys.exit(0)

# Check 3: `gh api ... -X PATCH ... state.*closed` on pulls endpoint
if re.search(r'\bgh\s+api\b.*pulls.*-X\s+PATCH.*state.*closed', cmd_for_token, re.IGNORECASE):
    print('BLOCKED_GH_API_CLOSE')
    sys.exit(0)

print('OK')
PYEOF
)

if [ "$RESULT" = "BLOCKED_GH_PR_CLOSE" ]; then
  echo "BLOCKED: 'gh pr close' is NEVER permitted from agent sessions (bd-ewoj)." >&2
  echo "Only humans may close PRs. If the PR should be closed, ask the user." >&2
  exit 2
fi

if [ "$RESULT" = "BLOCKED_GH_API_CLOSE" ]; then
  echo "BLOCKED: Closing a PR via GitHub REST API is NEVER permitted from agent sessions (bd-ewoj)." >&2
  echo "Only humans may close PRs. If the PR should be closed, ask the user." >&2
  exit 2
fi

exit 0
