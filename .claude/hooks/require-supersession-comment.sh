#!/bin/bash
# require-supersession-comment.sh — PreToolUse hook: block gh pr close without supersession comment
# 3 PRs were closed in 24h without any supersession comment documenting which PR replaced them.
# Per CLAUDE.md: "Closing a PR is allowed ONLY when it is superseded by another PR."
# Before closing: (1) verify all changes are in the superseding PR, (2) post "Superseded by #NNN".
#
# Fail-closed: if python3 is unavailable, API check fails, or repo cannot be determined — BLOCK.
# Uses stdin JSON approach (cat) — matches repo hook pattern.

set -euo pipefail

INPUT=$(cat)

# Fail closed: if python3 is absent, block all Bash tool calls containing 'pr close' or 'state=closed'
if ! command -v python3 >/dev/null 2>&1; then
  if echo "$INPUT" | grep -qiE 'pr.close|state.*closed'; then
    echo "BLOCKED: python3 unavailable — cannot verify supersession comment. Never close PRs without supersession." >&2
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

# Remove heredoc bodies to avoid false positives from text mentioning "gh pr close".
# Do NOT strip quoted strings — quotes are part of real command arguments (e.g.
# gh api \"repos/acme/pulls/123\" -X PATCH -f state=\"closed\") and removing them
# would destroy the repo/PR/verb tokens needed for pattern detection.
CMD_CLEAN=$(echo "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# Remove heredoc bodies (both <<'EOF' and <<EOF forms)
cmd = re.sub(r'<<[-]?[\"'\'']?\w+[\"'\'']?.*?^\w+$', '', cmd, flags=re.DOTALL|re.MULTILINE)
print(cmd)
" 2>/dev/null)

# Check for gh pr close or gh api REST close patterns
CLOSE_TYPE=$(echo "$CMD_CLEAN" | python3 -c "
import sys, re
cmd = sys.stdin.read()

# Check 1: \`gh pr close\` as an actual command
if re.search(r'\bgh\s+pr\s+close\b', cmd, re.IGNORECASE):
    print('GH_PR_CLOSE')
    sys.exit(0)

# Check 2: \`gh api ... --method PATCH -f state=closed\` (REST API close)
if re.search(r'\bgh\s+api\b.*pulls.*state.*closed', cmd, re.IGNORECASE):
    print('GH_API_CLOSE')
    sys.exit(0)

# Check 3: \`gh api ... -X PATCH ... state.*closed\` on pulls endpoint
if re.search(r'\bgh\s+api\b.*pulls.*-X\s+PATCH.*state.*closed', cmd, re.IGNORECASE):
    print('GH_API_CLOSE')
    sys.exit(0)

print('OK')
" 2>/dev/null)

if [ "$CLOSE_TYPE" = "OK" ]; then
  exit 0
fi

# Extract PR number from the command
PR_NUM=$(echo "$CMD_CLEAN" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# Extract PR number after 'gh pr close'
m = re.search(r'gh\s+pr\s+close\s+(?:--comment|--body|-c\s+\S+|-c\s+\"[^\"]*\"|--repo\s+\S+\s+)?(\d+)', cmd, re.IGNORECASE)
if m:
    print(m.group(1))
else:
    # Try gh api pulls/<N> form
    m = re.search(r'pulls[/\s]+(\d+)', cmd, re.IGNORECASE)
    if m:
        print(m.group(1))
    else:
        print('')
" 2>/dev/null) || PR_NUM=""

if [ -z "$PR_NUM" ]; then
  echo "BLOCKED: Could not extract PR number from close command." >&2
  echo "Block the close so a human can verify the target PR." >&2
  exit 2
fi

# Determine the repo: prefer explicit --repo from the gh command, fall back to git remote
REPO=$(echo "$CMD_CLEAN" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# Extract --repo owner/repo from the gh command
m = re.search(r'--repo\s+(\S+)', cmd, re.IGNORECASE)
if m:
    print(m.group(1).rstrip('/'))
    sys.exit(0)
print('')
" 2>/dev/null) || REPO=""

# Fall back to git remote origin if no explicit --repo found
if [ -z "$REPO" ]; then
  REPO=$(git remote get-url origin 2>/dev/null | python3 -c "
import sys, re
url = sys.stdin.read().strip()
m = re.search(r'github\.com[/:]([\w-]+/[\w.-]+?)(?:\.git)?$', url)
if m:
    print(m.group(1))
else:
    print('')
" 2>/dev/null) || REPO=""
fi

if [ -z "$REPO" ]; then
  echo "BLOCKED: Could not determine repository for PR #$PR_NUM." >&2
  echo "Block the close so a human can verify the target PR." >&2
  exit 2
fi

# Check for "Superseded by #" comment on the PR via REST API
RESULT=$(python3 - "$REPO" "$PR_NUM" <<'PYEOF'
import sys, subprocess, re

repo = sys.argv[1]
pr_num = sys.argv[2]

try:
    # Get all issue/PR comments using REST (paginate to ensure all pages are checked)
    result = subprocess.run(
        ["gh", "api", "--paginate", f"repos/{repo}/issues/{pr_num}/comments",
         "--jq", ".[].body"],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print("ERROR:API_FAILED")
        sys.exit(0)

    body = result.stdout

    # Look for "Superseded by #<number>" pattern — must have a digit after #
    if re.search(r'Superseded\s+by\s+#\d+', body, re.IGNORECASE):
        print("ALLOWED")
    else:
        print("BLOCKED")

except subprocess.TimeoutExpired:
    print("ERROR:TIMEOUT")
except FileNotFoundError:
    print("ERROR:GH_NOT_FOUND")
except Exception as e:
    print(f"ERROR:{e}")
PYEOF
) || RESULT="ERROR:UNKNOWN"

case "$RESULT" in
  ALLOWED)
    exit 0
    ;;
  BLOCKED)
    echo "" >&2
    echo "============================================" >&2
    echo "BLOCKED: PR #$PR_NUM has no supersession comment." >&2
    echo "" >&2
    echo "Per CLAUDE.md: Closing a PR is allowed ONLY when superseded by another PR." >&2
    echo "" >&2
    echo "Before closing PR #$PR_NUM:" >&2
    echo "  1. Verify ALL changes from this PR are present in the superseding PR." >&2
    echo '  2. Post this comment on the PR:' >&2
    echo "     'Superseded by #<superseding-PR-number> — all changes verified covered.'" >&2
    echo "  3. Then retry this command." >&2
    echo "" >&2
    echo "If this PR should be closed without a supersession (e.g. draft/abandoned)" >&2
    echo "ask the user to close it manually." >&2
    echo "============================================" >&2
    exit 2
    ;;
  ERROR:API_FAILED|ERROR:TIMEOUT|ERROR:GH_NOT_FOUND|ERROR:UNKNOWN|*)
    echo "BLOCKED: Could not verify supersession comment on PR #$PR_NUM (API/tool error)." >&2
    echo "Block the close so a human can verify the target PR." >&2
    exit 2
    ;;
esac
