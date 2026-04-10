const _ = String.raw;

export const PR_TITLE_PREFIX = "[agento] ";

export const PR_TITLE_PREFIX_GUARD_BLOCK = _`
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
`;
