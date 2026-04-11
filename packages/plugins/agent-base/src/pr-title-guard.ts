const _ = String.raw;

export const PR_TITLE_PREFIX = "[agento] ";
const BASH_NORMALIZE_PREFIX_STATUS = '${normalize_prefixed_command_out%%$\'\\n\'*}';
const BASH_NORMALIZE_PREFIX_PAYLOAD = '${normalize_prefixed_command_out#*$\'\\n\'}';
const BASH_REMATCH_CAPTURE_1 = '"${BASH_REMATCH[1]}"';
const BASH_REMATCH_CAPTURE_2 = '"${BASH_REMATCH[2]}"';

export const NORMALIZE_SHELL_COMMAND_PREFIX_BLOCK = _`
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

  normalize_prefixed_command_status=${BASH_NORMALIZE_PREFIX_STATUS}
  normalize_prefixed_command_payload=${BASH_NORMALIZE_PREFIX_PAYLOAD}
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
      clean_command=${BASH_REMATCH_CAPTURE_1}
    elif [[ "$clean_command" =~ $cd_prefix_pattern ]]; then
      clean_command=${BASH_REMATCH_CAPTURE_2}
    else
      break
    fi
  done
fi
`;

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
