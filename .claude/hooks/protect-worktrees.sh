#!/bin/bash
# protect-worktrees.sh — PreToolUse hook
# Blocks `git worktree remove` or `git worktree prune` as actual command invocations.
# Ignores occurrences inside commit messages, heredocs, or quoted strings.
# Only manual human execution in a terminal is allowed.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)

# Use Python to detect actual `git worktree remove/prune` invocations.
# Strategy: split on shell command separators (&&, ;, |, newlines),
# strip leading whitespace from each token, skip tokens that start with
# quotes or are preceded by -m/-F flags (commit message context).
BLOCKED=$(python3 - "$CMD" <<'PYEOF'
import sys, re

cmd = sys.argv[1]

# Remove heredoc bodies (everything between <<'MARKER' and MARKER on its own line)
cmd = re.sub(r"<<'?\w+'?.*?^\w+$", '', cmd, flags=re.DOTALL|re.MULTILINE)
# Remove double-quoted strings (simple heuristic)
cmd = re.sub(r'"[^"]*"', '""', cmd)
# Remove single-quoted strings
cmd = re.sub(r"'[^']*'", "''", cmd)

# Split on common shell separators
parts = re.split(r'[;&|\n]+', cmd)
for part in parts:
    part = part.strip()
    # Skip empty, or things that look like flag values
    if not part:
        continue
    # Normalize whitespace
    tokens = part.split()
    # Find `git worktree remove` or `git worktree prune` as leading tokens
    # (possibly after `unset X &&` or env var assignments)
    i = 0
    while i < len(tokens):
        t = tokens[i]
        # Skip env var assignments and `unset`
        if '=' in t or t == 'unset' or t == 'export':
            i += 1
            continue
        # Check for git worktree remove/prune
        if (t == 'git' and i+2 < len(tokens)
                and tokens[i+1] == 'worktree'
                and tokens[i+2] in ('remove', 'prune')):
            print('BLOCKED')
            sys.exit(0)
        break  # first real command token checked; stop
print('OK')
PYEOF
)

if [ "$BLOCKED" = "BLOCKED" ]; then
  echo "BLOCKED: 'git worktree remove/prune' requires explicit manual human approval." >&2
  echo "Run the command yourself in a terminal. Claude is never permitted to remove worktrees." >&2
  exit 2
fi

exit 0
