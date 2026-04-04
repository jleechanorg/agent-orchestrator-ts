#!/bin/bash
# churn-guard.sh — PreToolUse hook: block PR creation when open PRs already touch same files
# 8 PRs for metadata-updater.sh in 1hr on 2026-04-04 — 7 were wasted duplicates.
# Root cause: no file-level coordination gate at PR creation time.
#
# Intercepts: gh pr create, gh api repos/.../pulls --method POST
# Checks: do any open PRs in the same repo touch files changed in the current branch?
# If overlap found: BLOCK with list of overlapping PRs.
# Fail-open: if checks fail (no git, no gh, parse error), allow — don't block real work.

set -euo pipefail

INPUT=$(cat)

# Only intercept Bash tool calls
TOOL=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_name', ''))
except Exception:
    print('')
" 2>/dev/null) || TOOL=""

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('command', ''))
except Exception:
    print('')
" 2>/dev/null) || CMD=""

if [ -z "$CMD" ]; then
  exit 0
fi

# Detect PR creation commands
IS_PR_CREATE=$(echo "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
# gh pr create
if re.search(r'\bgh\s+pr\s+create\b', cmd, re.IGNORECASE):
    print('YES')
    sys.exit(0)
# gh api repos/.../pulls --method POST (REST PR creation)
if re.search(r'\bgh\s+api\b.*pulls\b.*--method\s+POST', cmd, re.IGNORECASE):
    print('YES')
    sys.exit(0)
print('NO')
" 2>/dev/null) || IS_PR_CREATE="NO"

if [ "$IS_PR_CREATE" != "YES" ]; then
  exit 0
fi

# --- PR creation detected — check for file overlap ---

# Get the repo (try --repo flag first, then git remote)
REPO=$(echo "$CMD" | python3 -c "
import sys, re
cmd = sys.stdin.read()
m = re.search(r'--repo\s+(\S+)', cmd, re.IGNORECASE)
if m:
    print(m.group(1).rstrip('/'))
    sys.exit(0)
# Try repos/OWNER/REPO/pulls pattern
m = re.search(r'repos/([^/]+/[^/]+)/pulls', cmd)
if m:
    print(m.group(1))
    sys.exit(0)
print('')
" 2>/dev/null) || REPO=""

# Fall back to git remote
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
  # Can't determine repo — fail open
  exit 0
fi

# Get files changed in current branch vs main
CHANGED_FILES=$(git diff --name-only origin/main...HEAD 2>/dev/null) || CHANGED_FILES=""

if [ -z "$CHANGED_FILES" ]; then
  # No changed files detected (maybe not in a git repo or on main) — fail open
  exit 0
fi

# Check open PRs for file overlap
OVERLAP=$(python3 - "$REPO" "$CHANGED_FILES" <<'PYEOF'
import sys, subprocess, json

repo = sys.argv[1]
my_files = set(sys.argv[2].strip().split('\n'))

try:
    # Get current branch to exclude our own PR
    branch_result = subprocess.run(
        ["git", "branch", "--show-current"],
        capture_output=True, text=True, timeout=5
    )
    my_branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""

    # List open PRs with their files
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls",
         "--jq", '.[] | {number, title, head: .head.ref, files_url: .url}',
         "-q", "state=open"],
        capture_output=True, text=True, timeout=30
    )

    if result.returncode != 0:
        # API failed — fail open
        print("OK")
        sys.exit(0)

    # Parse PR list
    result2 = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls", "--method", "GET",
         "--jq", "[.[] | {number: .number, title: .title, branch: .head.ref}]"],
        capture_output=True, text=True, timeout=30
    )

    if result2.returncode != 0:
        print("OK")
        sys.exit(0)

    prs = json.loads(result2.stdout)

    overlapping = []
    for pr in prs:
        # Skip our own branch
        if pr.get("branch") == my_branch:
            continue

        # Get files for this PR
        files_result = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{pr['number']}/files",
             "--jq", ".[].filename"],
            capture_output=True, text=True, timeout=15
        )

        if files_result.returncode != 0:
            continue

        pr_files = set(files_result.stdout.strip().split('\n'))
        common = my_files & pr_files

        if common:
            overlapping.append({
                "number": pr["number"],
                "title": pr["title"],
                "files": list(common)
            })

    if overlapping:
        lines = ["OVERLAP"]
        for o in overlapping:
            files_str = ", ".join(o["files"][:3])
            if len(o["files"]) > 3:
                files_str += f" (+{len(o['files'])-3} more)"
            lines.append(f"  PR #{o['number']}: {o['title']} — overlapping: {files_str}")
        print("\n".join(lines))
    else:
        print("OK")

except subprocess.TimeoutExpired:
    print("OK")  # fail open
except Exception:
    print("OK")  # fail open
PYEOF
) || OVERLAP="OK"

if echo "$OVERLAP" | grep -q "^OVERLAP"; then
  echo "" >&2
  echo "============================================" >&2
  echo "BLOCKED: File overlap with existing open PRs" >&2
  echo "" >&2
  echo "Your branch changes files that are already being modified by open PRs:" >&2
  echo "$OVERLAP" | tail -n +2 >&2
  echo "" >&2
  echo "To prevent churn (8 duplicate PRs for metadata-updater.sh on 2026-04-04):" >&2
  echo "  1. Check if the existing PR already covers your fix" >&2
  echo "  2. If yes: post your changes as a review comment on that PR instead" >&2
  echo "  3. If no: coordinate with the existing PR author via MCP mail" >&2
  echo "  4. Only create a new PR if the existing one is abandoned/stale (>24h no activity)" >&2
  echo "" >&2
  echo "To override (if you're intentionally superseding): add --body containing" >&2
  echo "'Supersedes #<N>' to your gh pr create command." >&2
  echo "============================================" >&2
  exit 2
fi

exit 0
