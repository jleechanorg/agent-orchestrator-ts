#!/usr/bin/env bash
# Metadata Updater Hook for Agent Orchestrator
#
# This PostToolUse hook automatically updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name and writes to metadata
# - gh pr merge: updates status to "merged"

set -euo pipefail

# Configuration
AO_DATA_DIR="${AO_DATA_DIR:-${HOME}/.ao-sessions}"

# Read hook input from stdin
input=$(cat)

# Extract fields from JSON (using jq if available, otherwise basic parsing)
if command -v jq &>/dev/null; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  output=$(echo "$input" | jq -r '.tool_response // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
  hook_event=$(echo "$input" | jq -r '.hook_event_name // empty')
else
  # Fallback: basic JSON parsing without jq
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
  hook_event=$(echo "$input" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
fi

# Only process successful commands (exit code 0)
if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

# Only process Bash tool calls
if [[ "$tool_name" != "Bash" ]]; then
  echo '{}' # Empty JSON output
  exit 0
fi

# ============================================================================
# Command Detection and Parsing
# ============================================================================

# Strip leading prefixes so commands like
#   cd ~/.worktrees/project && gh pr create ...
#   FOO=bar gh pr create ...
# are correctly detected. Agents frequently cd into a worktree first.
# Store the regex pattern in a variable for clarity (avoids shell quoting confusion).
# Uses space-padded (&&|;) to avoid breaking on paths containing & or ; chars.
cd_prefix_pattern='^[[:space:]]*cd[[:space:]]+.*[[:space:]]+(&&|;)[[:space:]]+(.*)'
clean_command="$command"
while true; do
  # Strip leading env assignments: FOO=bar BAZ=qux gh pr create ...
  if [[ "$clean_command" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^= ]*)[[:space:]]+(.+)$ ]]; then
    clean_command="${BASH_REMATCH[2]}"
  # Strip leading cd prefixes: cd /path && gh pr create ...
  elif [[ "$clean_command" =~ $cd_prefix_pattern ]]; then
    clean_command="${BASH_REMATCH[2]}"
  else
    break
  fi
done

# Guardrail: enforce [agento] prefix on gh pr create titles (PreToolUse only).
# PostToolUse falls through to metadata update — no need to re-check there.
pr_create_pattern='^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
if [[ "$hook_event" == "PreToolUse" && "$clean_command" =~ $pr_create_pattern ]]; then
  # Parse --title or -t as proper argv tokens (not substring in --body etc.).
  # Python shlex correctly handles quoted strings containing literal "--title".
  first_title=$(python3 -c "
import shlex, sys
args = shlex.split(sys.argv[1])
for i, arg in enumerate(args):
    if arg == '--title':
        print(args[i+1], end='')
        break
    if arg.startswith('--title='):
        print(arg[len('--title='):], end='')
        break
    if arg == '-t':
        print(args[i+1], end='')
        break
    if arg.startswith('-t'):
        print(arg[2:], end='')
        break
" "$clean_command" 2>/dev/null || true)
  if [[ -z "$first_title" || "$first_title" != \[agento\]* ]]; then
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Blocked by AO policy: gh pr create titles must start with [agento]. Prefix your title with [agento] and retry.\"}}"
    exit 0
  fi
  # Prefix check passed — title is valid, allow the tool.
  # Exit here so PreToolUse does NOT fall through to metadata writers below.
  echo '{}'
  exit 0
fi

# Hard guardrail: block agent-triggered gh pr merge by default.
# Placed BEFORE the PostToolUse-only guard so PreToolUse denials fire correctly.
# Rationale: prompt rules (e.g., "NEVER MERGE") are advisory; this enforces policy in code.
# Escape hatch for trusted/manual flows: AO_ALLOW_GH_PR_MERGE=1
merge_pattern='^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'
if [[ "$clean_command" =~ $merge_pattern ]]; then
  if [[ "$hook_event" != "PostToolUse" && ${AO_ALLOW_GH_PR_MERGE:-_} != "1" ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by AO policy: agents must not run gh pr merge. Leave merge to orchestrator/human."}}'
    exit 0
  fi
fi

# All metadata writers run in PostToolUse only.
# Allow PreToolUse (hook_event empty or "PreToolUse") to fall through to guards above.
if [[ "$hook_event" != "PostToolUse" && -n "$hook_event" ]]; then
  echo '{}'
  exit 0
fi

# Validate AO_SESSION is set
if [[ -z ${AO_SESSION:-} ]]; then
  echo '{"systemMessage": "AO_SESSION environment variable not set, skipping metadata update"}'
  exit 0
fi

# Construct metadata file path
# AO_DATA_DIR is already set to the project-specific sessions directory
metadata_file="$AO_DATA_DIR/$AO_SESSION"

# Ensure metadata file exists
if [[ ! -f "$metadata_file" ]]; then
  echo '{"systemMessage": "Metadata file not found: '"$metadata_file"'"}'
  exit 0
fi

# Update a single key in metadata
update_metadata_key() {
  local key="$1"
  local value="$2"

  # Create temp file
  local temp_file="${metadata_file}.tmp"

  # Escape special sed characters in value (& and \ — not | or / in BRE)
  local escaped_value=$(echo "$value" | sed 's/[&\\]/\\&/g')

  # Check if key already exists
  if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
    # Update existing key
    sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
  else
    # Append new key
    cp "$metadata_file" "$temp_file"
    echo "$key=$value" >> "$temp_file"
  fi

  # Atomic replace
  mv "$temp_file" "$metadata_file"
}

# Detect: gh pr create (uses same pr_create_pattern as the guardrail above)
if [[ "$clean_command" =~ $pr_create_pattern ]]; then
  # Extract PR URL from output
  pr_url=$(echo "$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1 || true)

  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    update_metadata_key "status" "pr_open"
    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi

# Detect: git checkout -b <branch> or git switch -c <branch>
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]]; then
  branch="${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git switch -c <branch>
if [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git checkout <branch> (without -b) or git switch <branch> (without -c)
# Only update if the branch name looks like a feature branch (contains / or -)
if [[ "$clean_command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="${BASH_REMATCH[1]}"
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

if [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="${BASH_REMATCH[1]}"
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: gh pr merge (only when explicitly allowed AND in PostToolUse — not PreToolUse)
# Gate on PostToolUse to avoid marking status=merged before the merge actually succeeds.
if [[ "$clean_command" =~ $merge_pattern && ${AO_ALLOW_GH_PR_MERGE:-_} == "1" && "$hook_event" == "PostToolUse" ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage": "Updated metadata: status = merged"}'
  exit 0
fi

# No matching command, exit silently
echo '{}'
exit 0
