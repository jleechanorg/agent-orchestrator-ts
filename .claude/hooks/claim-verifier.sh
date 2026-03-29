#!/usr/bin/env bash
# claim-verifier.sh — PreToolUse hook (bd-upxh)
#
# Enforces harness-level claim-verification for skeptic gate assertions:
#   "no agent may report 'working' unless run-level AND comment-level evidence passes."
#
# This hook intercepts `gh pr create` to enforce the always-comment policy:
# - Verifies the PR body has a **Claim class**: field
# - Verifies the Evidence section has a VERDICT line
# - Blocks the command if evidence is missing (fail-closed)
#
# Always-comment policy (non-eligible/error paths):
# - If evidence is absent from PR body, this is a harness gap — block and report.
#
# Usage: Add to settings.json PreToolUse hooks array:
#   "preToolUse": [{"name": "claim-verifier", "path": ".claude/hooks/claim-verifier.sh"}]

set -euo pipefail

INPUT=$(cat)

# ---------------------------------------------------------------------------
# Parse tool_name and command from hook JSON input
# ---------------------------------------------------------------------------

if ! command -v python3 >/dev/null 2>&1; then
  # Cannot safely parse — let the command through but warn
  echo "WARN: python3 unavailable — claim-verifier skipped" >&2
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

if [ "$TOOL" = "PARSE_ERROR" ] || [ "$TOOL" != "Bash" ]; then
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
  exit 0
fi

# ---------------------------------------------------------------------------
# Only intercept gh pr create (and gh pr edit for updating body)
# ---------------------------------------------------------------------------

if ! echo "$CMD" | grep -qE '^[[:space:]]*gh[[:space:]]+pr[[:space:]]+(create|edit)[[:space:]]'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Extract PR body — gh pr create uses --body flag or stdin
# ---------------------------------------------------------------------------

# Try --body flag first
BODY=$(echo "$CMD" | grep -oE '\-\-body[[:space:]]+'"'"'[^'"'"']*'"'"'([^[:space:]]+)?' | \
       sed "s/--body[[:space:]]*'"'"'//; s/'"'"'$//" | tr '\n' ' ' | sed 's/[[:space:]]*$//')

# Fallback: try double-quoted body
if [ -z "$BODY" ]; then
  BODY=$(echo "$CMD" | grep -oE '--body[[:space:]]+"[^"]*"' | \
         sed 's/--body[[:space:]]*"//; s/"$//' | tr '\n' ' ' | sed 's/[[:space:]]*$//')
fi

# ---------------------------------------------------------------------------
# Verify Evidence section exists
# ---------------------------------------------------------------------------
if ! echo "$BODY" | grep -qiE '^[[:space:]]*##[[:space:]]+[Ee]vidence'; then
  echo "BLOCKED: gh pr create/edit requires a ## Evidence section in the PR body." >&2
  echo "FAIL-CLOSED: No evidence found — cannot verify claim." >&2
  echo "" >&2
  echo "Add this section to your PR body:" >&2
  echo '## Evidence' >&2
  echo '**Claim class**: merge-gate' >&2
  echo 'VERDICT: PASS' >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Verify **Claim class**: field is present
# ---------------------------------------------------------------------------
if ! echo "$BODY" | grep -qiE '\*\*Claim class\*\*:'; then
  echo "BLOCKED: gh pr create/edit requires **Claim class**: field in Evidence section." >&2
  echo "FAIL-CLOSED: Missing claim class — cannot verify claim type." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Verify VERDICT line is present in Evidence section
# ---------------------------------------------------------------------------
# Extract from ## Evidence to end of body
EVIDENCE=$(echo "$BODY" | sed -n '/^[[:space:]]*## Evidence/,$p')
if ! echo "$EVIDENCE" | grep -qiE '[Vv]erdict[[:space:]]*:[[:space:]]*(PASS|FAIL|INSUFFICIENT)'; then
  echo "BLOCKED: gh pr create/edit requires a VERDICT line (PASS/FAIL/INSUFFICIENT) in Evidence section." >&2
  echo "FAIL-CLOSED: Missing verdict — claim cannot be verified." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Claim class validation — warn on unrecognized classes
# ---------------------------------------------------------------------------
CLAIM=$(echo "$BODY" | grep -iE '\*\*Claim class\*\*:' | head -1 | \
         sed 's/.*\*\*Claim class\*\*: *//I; s/[[:space:]]*(.*//' | tr '[:upper:]' '[:lower:]' | tr -d '*')

case "$CLAIM" in
  unit|integration|pipeline-e2e|pr-lifecycle-e2e|merge-gate)
    echo "INFO: claim-verifier passed — **Claim class**: $CLAIM, verdict present"
    ;;
  *)
    echo "WARN: Unrecognized claim class '$CLAIM' — verify against evidence-standards.md" >&2
    ;;
esac

exit 0
