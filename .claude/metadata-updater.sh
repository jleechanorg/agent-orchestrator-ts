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

# Only process shell tool calls (Claude uses "Bash"; Gemini CLI uses "run_shell_command")
if [[ "$tool_name" != "Bash" && "$tool_name" != "run_shell_command" ]]; then
  echo '{}' # Empty JSON output
  exit 0
fi

# ============================================================================
# Command Detection and Parsing
# ============================================================================


clean_command="$command"
if command -v python3 >/dev/null 2>&1; then
  normalize_prefixed_command_out=$(python3 - "$command" <<'PY'
import sys

def tokenize(source):
    tokens = []
    i = 0
    length = len(source)
    while i < length:
        while i < length and source[i].isspace():
            i += 1
        if i >= length:
            break
        if source.startswith("&&", i):
            tokens.append(("op", "&&", i, i + 2))
            i += 2
            continue
        if source[i] == ";":
            tokens.append(("op", ";", i, i + 1))
            i += 1
            continue

        start = i
        while i < length:
            if source.startswith("&&", i) or source[i] == ";" or source[i].isspace():
                break
            char = source[i]
            if char == "'":
                i += 1
                while i < length and source[i] != "'":
                    i += 1
                if i >= length:
                    raise ValueError("unterminated single quote")
                i += 1
                continue
            if char == '"':
                i += 1
                while i < length:
                    inner = source[i]
                    if inner == "\\":
                        i += 2
                        continue
                    if inner == '"':
                        i += 1
                        break
                    i += 1
                else:
                    raise ValueError("unterminated double quote")
                continue
            if char == "\\":
                if i + 1 >= length:
                    raise ValueError("unterminated escape")
                i += 2
                continue
            if char in "|&<>(){}":
                raise ValueError("unsupported shell operator")
            i += 1
        tokens.append(("word", source[start:i], start, i))
    return tokens

def is_assignment(word):
    if "=" not in word:
        return False
    name, _value = word.split("=", 1)
    return bool(name) and (name[0].isalpha() or name[0] == "_") and all(
        ch.isalnum() or ch == "_" for ch in name[1:]
    )

def strip_assignments(words):
    index = 0
    while index < len(words) and is_assignment(words[index]):
        index += 1
    return words[index:]

def is_guarded_segment(words):
    words = strip_assignments(words)
    return (
        len(words) >= 3 and words[0] == "gh" and words[1] == "pr" and words[2] in {"create", "merge"}
    )

def remaining_segments_contain_guarded(tokens, start_index):
    index = start_index
    while index < len(tokens):
        if tokens[index][0] != "word":
            index += 1
            continue
        segment_end = index
        while segment_end < len(tokens) and tokens[segment_end][0] == "word":
            segment_end += 1
        words = [token[1] for token in tokens[index:segment_end]]
        if is_guarded_segment(words):
            return True
        index = segment_end + 1
    return False

source = sys.argv[1]

try:
    tokens = tokenize(source)
except ValueError:
    print("raw")
    print(source)
    raise SystemExit(0)

index = 0
while index < len(tokens) and tokens[index][0] == "word" and is_assignment(tokens[index][1]):
    index += 1

while index < len(tokens):
    if tokens[index][0] != "word":
        print("raw")
        print(source)
        raise SystemExit(0)

    segment_end = index
    while segment_end < len(tokens) and tokens[segment_end][0] == "word":
        segment_end += 1

    words = [token[1] for token in tokens[index:segment_end]]
    next_op = tokens[segment_end][1] if segment_end < len(tokens) else None

    if words and words[0] == "cd":
        if len(words) != 2 or next_op not in {"&&", ";"}:
            print("raw")
            print(source)
            raise SystemExit(0)
        index = segment_end + 1
        while index < len(tokens) and tokens[index][0] == "word" and is_assignment(tokens[index][1]):
            index += 1
        continue

    if next_op is not None:
        if is_guarded_segment(words) or remaining_segments_contain_guarded(tokens, segment_end + 1):
            print("deny")
            print("Blocked by AO policy: cannot safely analyze chained shell commands before gh pr create or gh pr merge. Run the guarded command directly after any env assignments or cd prefixes.")
            raise SystemExit(0)
        print("raw")
        print(source)
        raise SystemExit(0)

    print("safe")
    print(source[tokens[index][2]:])
    raise SystemExit(0)

print("raw")
print(source)
PY
)

  normalize_prefixed_command_status=${normalize_prefixed_command_out%%$'\n'*}
  normalize_prefixed_command_payload=${normalize_prefixed_command_out#*$'\n'}
  if [[ "$normalize_prefixed_command_status" == "deny" && "$hook_event" == "PreToolUse" ]]; then
    python3 - "$normalize_prefixed_command_payload" <<'PY'
import json
import sys

print(
    json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": sys.argv[1],
            }
        }
    )
)
PY
    exit 0
  fi
  if [[ "$normalize_prefixed_command_status" == "safe" ]]; then
    clean_command="$normalize_prefixed_command_payload"
  fi
else
  cd_prefix_pattern='^[[:space:]]*cd[[:space:]]+.*[[:space:]]+(&&|;)[[:space:]]+(.*)'
  while true; do
    if [[ "$clean_command" =~ ^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+(.+)$ ]]; then
      clean_command="${BASH_REMATCH[1]}"
    elif [[ "$clean_command" =~ $cd_prefix_pattern ]]; then
      clean_command="${BASH_REMATCH[2]}"
    else
      break
    fi
  done
fi



# Guardrail: ensure [agento] prefix on gh pr create titles (PreToolUse only).
# If --title/-t is present without the prefix, prepend it via updatedInput.
# PostToolUse falls through to metadata update — no re-check there.
pr_create_pattern='^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
if [[ "$hook_event" == "PreToolUse" && "$clean_command" =~ $pr_create_pattern ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by AO policy: python3 is required to safely rewrite gh pr create titles."}}'
    exit 0
  fi

  pr_title_hook_out=$(python3 - "$clean_command" "$command" <<'PY'
import json
import shlex
import sys

PREFIX = "[agento] "

def deny(reason):
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    raise SystemExit(0)

def shell_word_spans(source):
    spans = []
    i = 0
    length = len(source)
    while i < length:
        while i < length and source[i].isspace():
            i += 1
        if i >= length:
            break
        start = i
        while i < length and not source[i].isspace():
            char = source[i]
            if char == "'":
                i += 1
                while i < length and source[i] != "'":
                    i += 1
                if i >= length:
                    raise ValueError("unterminated single quote")
                i += 1
                continue
            if char == '"':
                i += 1
                while i < length:
                    inner = source[i]
                    if inner == "\\":
                        i += 2
                        continue
                    if inner == '"':
                        i += 1
                        break
                    i += 1
                else:
                    raise ValueError("unterminated double quote")
                continue
            if char == "\\":
                if i + 1 >= length:
                    raise ValueError("unterminated escape")
                i += 2
                continue
            i += 1
        spans.append((start, i, source[start:i]))
    return spans

def get_title_mode(args):
    for index, arg in enumerate(args):
        if arg == "--title" and index + 1 < len(args):
            return "next", index + 1
        if arg.startswith("--title="):
            return "embed", index
        if arg == "-t" and index + 1 < len(args):
            return "next", index + 1
        if arg.startswith("-t="):
            return "short_equals", index
        if arg.startswith("-t") and arg != "-t" and len(arg) > 2:
            return "short", index
    return None, None

def prefix_fragment(raw_value):
    if raw_value.startswith("'") and raw_value.endswith("'") and len(raw_value) >= 2:
        return "'" + PREFIX + raw_value[1:]
    if raw_value.startswith('"') and raw_value.endswith('"') and len(raw_value) >= 2:
        return '"' + PREFIX + raw_value[1:]
    return "'" + PREFIX + "'" + raw_value

clean = sys.argv[1]
full = sys.argv[2]

if not full.endswith(clean):
    deny("Blocked by AO policy: unable to safely map gh pr create title back to the original command text.")

prefix = full[:-len(clean)]

try:
    args = shlex.split(clean)
    spans = shell_word_spans(clean)
except ValueError as exc:
    deny(f"Blocked by AO policy: unable to safely parse gh pr create title ({exc}).")

if len(args) != len(spans):
    deny("Blocked by AO policy: unable to safely preserve gh pr create shell quoting while rewriting the title.")

if len(args) < 3 or args[0] != "gh" or args[1] != "pr" or args[2] != "create":
    print("{}")
    raise SystemExit(0)

mode, index = get_title_mode(args)
if mode is None:
    deny("Blocked by AO policy: gh pr create must include --title (or -t) so [agento] can be applied.")

if mode == "next":
    title = args[index]
elif mode == "embed":
    title = args[index][len("--title="):]
elif mode == "short_equals":
    title = args[index][len("-t="):]
else:
    title = args[index][2:]

if title.startswith(PREFIX):
    print("{}")
    raise SystemExit(0)

token_start, token_end, raw_token = spans[index]
if mode == "next":
    rewritten_token = prefix_fragment(raw_token)
elif mode == "embed":
    rewritten_token = "--title=" + prefix_fragment(raw_token[len("--title="):])
elif mode == "short_equals":
    rewritten_token = "-t=" + prefix_fragment(raw_token[len("-t="):])
else:
    rewritten_token = "-t" + prefix_fragment(raw_token[2:])

new_clean = clean[:token_start] + rewritten_token + clean[token_end:]
new_full = prefix + new_clean

print(
    json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "AO policy: prepended [agento] to gh pr create title.",
                "updatedInput": {"command": new_full},
            }
        }
    )
)
PY
)

  echo "$pr_title_hook_out"
  exit 0
fi


# All metadata writers run in PostToolUse only.
# Allow PreToolUse (hook_event empty or "PreToolUse") to fall through to guards above.
if [[ "$hook_event" != "PostToolUse" && -n "$hook_event" ]]; then
  echo '{}'
  exit 0
fi

# Hard guardrail: block agent-triggered gh pr merge by default.
# Escape hatch for trusted/manual flows: AO_ALLOW_GH_PR_MERGE=1
# This check runs BEFORE AO_SESSION/metadata checks since blocking a merge doesn't require session metadata.
# Guard fires when NOT PostToolUse and NOT allowed. PostToolUse falls through for metadata update.
# Known limitation: this pattern intentionally does NOT match wrapped/absolute forms
# (e.g., \`command gh pr merge\`, \`/usr/bin/gh pr merge\`, \`env gh pr merge\`, \`sudo gh pr merge\`).
# Agents in this codebase generate simple \`gh pr merge\` invocations; wrapped forms would be
# unusual and deliberate. Layered defenses apply regardless: PreToolUse blocks ALL tool calls
# containing "gh pr merge" in the raw input before this script runs, and agent-codex's gh
# wrapper also gates on AO_ALLOW_GH_PR_MERGE. The risk of a bypassed merge is therefore
# negligible while the pattern remains readable and maintainable.
merge_pattern='^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'
if [[ "$clean_command" =~ $merge_pattern ]]; then
  if [[ "$hook_event" != "PostToolUse" && ${AO_ALLOW_GH_PR_MERGE:-_} != "1" ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by AO policy: agents must not run gh pr merge. Leave merge to orchestrator/human."}}'
    exit 0
  fi
  # AO_ALLOW_GH_PR_MERGE=1 during PreToolUse OR PostToolUse: fall through to metadata update below
fi

# Validate AO_SESSION is set
if [[ -z ${AO_SESSION:-} ]]; then
  echo '{}'
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

if [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="${BASH_REMATCH[1]}"

  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

if [[ "$clean_command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="${BASH_REMATCH[1]}"

  # Avoid updating for checkout of commits/tags
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
