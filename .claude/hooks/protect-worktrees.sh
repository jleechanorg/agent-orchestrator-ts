#!/bin/bash
# protect-worktrees.sh — PreToolUse hook
# Blocks `git worktree remove` or `git worktree prune` as actual command invocations.
# Ignores occurrences inside commit messages, heredocs, or quoted strings.
# Only manual human execution in a terminal is allowed.
#
# Fail-closed: if python3 is unavailable or JSON is unparseable, BLOCK the command.
# Known bypass: `bash -c 'git worktree remove ...'` is not caught (shell re-invocation
# is out of scope for a pre-tool hook without full shell parsing).

set -euo pipefail

INPUT=$(cat)

# Fail closed: if python3 is absent, block all Bash tool calls containing 'worktree'
if ! command -v python3 >/dev/null 2>&1; then
  if echo "$INPUT" | grep -q 'worktree'; then
    echo "BLOCKED: python3 unavailable — cannot safely parse command. Run worktree commands manually." >&2
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

# If JSON parse failed, fail closed only if input contains 'worktree'
if [ "$TOOL" = "PARSE_ERROR" ]; then
  if echo "$INPUT" | grep -q 'worktree'; then
    echo "BLOCKED: JSON parse error — cannot safely evaluate command containing 'worktree'." >&2
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

# Use Python to detect actual `git worktree remove/prune` invocations.
# Strategy: split on shell command separators (&&, ;, |, newlines),
# strip heredoc bodies and quoted strings, then scan for git worktree patterns.
# Also handles `git -C <path> worktree` and `git --git-dir=<x> worktree` forms.
RESULT=$(python3 - "$CMD" <<'PYEOF'
import sys, re

cmd = sys.argv[1]

# Remove heredoc bodies: <<'MARKER'...MARKER or <<MARKER...MARKER
cmd = re.sub(r'<<[-]?["\']?\w+["\']?.*?^\w+$', '', cmd, flags=re.DOTALL|re.MULTILINE)
# Remove double-quoted strings
cmd = re.sub(r'"[^"]*"', '""', cmd)
# Remove single-quoted strings
cmd = re.sub(r"'[^']*'", "''", cmd)

# Split on common shell separators
parts = re.split(r'[;&|\n]+', cmd)
for part in parts:
    part = part.strip()
    if not part:
        continue
    tokens = part.split()
    i = 0
    while i < len(tokens):
        t = tokens[i]
        # Skip env var assignments, unset, export, sudo, command, env, nohup, nice, time
        if ('=' in t or t in ('unset', 'export', 'sudo', 'command', 'env',
                               'nohup', 'nice', 'time', 'exec')):
            i += 1
            continue
        if t == 'git':
            # Skip git global flags: -C <path>, --git-dir=<x>, --work-tree=<x>, -c <k=v>, etc.
            j = i + 1
            while j < len(tokens):
                tok = tokens[j]
                if tok in ('-C', '--git-dir', '--work-tree', '-c', '--namespace',
                           '--super-prefix', '--exec-path'):
                    j += 2  # skip flag + value
                elif tok.startswith('--git-dir=') or tok.startswith('--work-tree=') or tok.startswith('-c'):
                    j += 1  # skip combined flag=value
                elif tok.startswith('-'):
                    j += 1  # skip other single flags
                else:
                    break
            # j now points at the git subcommand
            if (j < len(tokens) and tokens[j] == 'worktree' and
                    j + 1 < len(tokens) and tokens[j + 1] in ('remove', 'prune')):
                print('BLOCKED')
                sys.exit(0)
            break
        break  # first real command token is not git; stop
print('OK')
PYEOF
)

if [ "$RESULT" != "OK" ]; then
  echo "BLOCKED: 'git worktree remove/prune' requires explicit manual human approval." >&2
  echo "Run the command yourself in a terminal. Claude is never permitted to remove worktrees." >&2
  exit 2
fi

exit 0
