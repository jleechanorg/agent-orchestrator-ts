#!/usr/bin/env python3
"""PreToolUse guard helper for metadata-updater.sh.

Reads the source command from AO_SOURCE_COMMAND environment variable and
classifies it as 'deny', 'safe', or 'raw'. Outputs to stdout.
"""
import os
import sys

GUARDED_REDACTED_SUBSTITUTION = "Blocked by AO policy: command substitution cannot safely hide gh pr create or gh pr merge. Run the guarded command directly without using $() or backticks to wrap it."
GUARDED_REDACTED_CHAIN = "Blocked by AO policy: cannot safely analyze chained shell commands containing gh pr create or gh pr merge. Run the guarded command directly without pipes, grouping, or process substitution."
GUARDED_REDACTED_INLINE = "Blocked by AO policy: cannot safely analyze chained shell commands before gh pr create or gh pr merge. Run the guarded command directly after any env assignments or cd prefixes."

BACKTICK = chr(96)


def find_dollar_paren(source):
    """Return index of $( outside single-quotes, or -1."""
    i = 0
    length = len(source)
    while i < length:
        char = source[i]
        if char == "'":
            i += 1
            while i < length and source[i] != "'":
                i += 1
            if i < length:
                i += 1
            continue
        if char == "$" and i + 1 < length and source[i + 1] == "(":
            return i
        if char == "\\" and i + 1 < length:
            i += 2
            continue
        if char == '"':
            i += 1
            while i < length:
                if source[i] == "\\" and i + 1 < length:
                    i += 2
                    continue
                if source[i] == '"':
                    i += 1
                    break
                if source[i] == "$" and i + 1 < length and source[i + 1] == "(":
                    return i
                i += 1
            continue
        i += 1
    return -1


def find_backtick(source):
    """Return index of backtick outside single-quotes, or -1."""
    i = 0
    length = len(source)
    while i < length:
        char = source[i]
        if char == "'":
            i += 1
            while i < length and source[i] != "'":
                i += 1
            if i < length:
                i += 1
            continue
        if char == BACKTICK:
            return i
        if char == "\\" and i + 1 < length:
            i += 2
            continue
        if char == '"':
            i += 1
            while i < length:
                if source[i] == "\\" and i + 1 < length:
                    i += 2
                    continue
                if source[i] == '"':
                    i += 1
                    break
                if source[i] == BACKTICK:
                    return i
                i += 1
            continue
        i += 1
    return -1


def find_unsafe_operator(source):
    """Return index of |/(/)/{/}/<(/>( outside single quotes and outside double-quoted $(), or -1."""
    i = 0
    length = len(source)
    while i < length:
        char = source[i]
        if char == "'":
            i += 1
            while i < length and source[i] != "'":
                i += 1
            if i < length:
                i += 1
            continue
        if char == "\\" and i + 1 < length:
            i += 2
            continue
        if char == '"':
            i += 1
            while i < length:
                if source[i] == "\\" and i + 1 < length:
                    i += 2
                    continue
                if source[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        if char in "(){}|":
            return i
        if char == "<" and i + 1 < length and source[i + 1] == "(":
            return i
        if char == ">" and i + 1 < length and source[i + 1] == "(":
            return i
        i += 1
    return -1


def has_any_guarded_text(source):
    # Strip single and double quotes so 'gh' pr merge and "gh" pr merge still match.
    cleaned = source.replace("'", "").replace('"', "")
    return "gh pr create" in cleaned or "gh pr merge" in cleaned


def starts_with_guarded_or_eval(source, start):
    """Return True if source[start:] (after whitespace) starts with gh/eval followed by pr (for gh)."""
    i = start
    length = len(source)
    while i < length and source[i].isspace():
        i += 1
    if i >= length:
        return False
    # Check for eval (special case - eval executes its string argument)
    if source[i] == "e":
        # Check if it's "eval"
        if source[i:i + 4] == "eval" and (i + 4 >= length or not source[i + 4].isalnum()):
            return True
    # Check for gh (possibly quoted)
    if source[i] == "'" or source[i] == '"':
        quote = source[i]
        if i + 1 < length and source[i + 1] == "g" and i + 2 < length and source[i + 2] == "h":
            if i + 3 < length and source[i + 3] == quote:
                return True
    if source[i] == "g" and i + 1 < length and source[i + 1] == "h":
        return True
    return False


def contains_guarded_after_chain(source):
    """Return True if source contains && or ; outside quotes followed by a guarded command."""
    i = 0
    length = len(source)
    while i < length:
        char = source[i]
        if char == "'":
            i += 1
            while i < length and source[i] != "'":
                i += 1
            if i < length:
                i += 1
            continue
        if char == '"':
            i += 1
            while i < length:
                if source[i] == "\\" and i + 1 < length:
                    i += 2
                    continue
                if source[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        if char == "\\" and i + 1 < length:
            i += 2
            continue
        if source.startswith("&&", i) or source[i] == ";":
            if has_any_guarded_text(source[i:]):
                return True
        i += 1
    return False


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
            if char in "|<>(){}":
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


def is_assignment_segment(words):
    return bool(words) and all(is_assignment(w) for w in words)


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


def main():
    source = os.environ.get("AO_SOURCE_COMMAND", "")
    if not source:
        print("raw")
        print("")
        return

    if find_dollar_paren(source) != -1 or find_backtick(source) != -1:
        # Deny if the substitution starts with a guarded command (possibly with quotes around
        # the gh keyword), starts with `eval` (which executes its string argument), or
        # contains a chain operator followed by a guarded command.
        dp = find_dollar_paren(source)
        bt = find_backtick(source)
        if dp != -1 and (starts_with_guarded_or_eval(source, dp + 2) or contains_guarded_after_chain(source[dp:])):
            print("deny")
            print(GUARDED_REDACTED_SUBSTITUTION)
            return
        if bt != -1 and (starts_with_guarded_or_eval(source, bt + 1) or contains_guarded_after_chain(source[bt:])):
            print("deny")
            print(GUARDED_REDACTED_SUBSTITUTION)
            return

    if find_unsafe_operator(source) != -1:
        # Skip ( and ) that are part of $() command substitution syntax. The substitution
        # check above already handles $() cases.
        has_subst_paren = find_dollar_paren(source) != -1
        unsafe_idx = find_unsafe_operator(source)
        if has_subst_paren and source[unsafe_idx] in "()":
            # This ( or ) is likely part of $() syntax; the substitution check handles it.
            pass
        elif has_any_guarded_text(source):
            print("deny")
            print(GUARDED_REDACTED_CHAIN)
            return

    try:
        tokens = tokenize(source)
    except ValueError:
        print("raw")
        print(source)
        return

    index = 0
    first_safe_payload = None

    while index < len(tokens):
        if tokens[index][0] != "word":
            if tokens[index][0] == "op" and tokens[index][1] in {"&&", ";"}:
                index += 1
                continue
            print("raw")
            print(source)
            return

        segment_end = index
        while segment_end < len(tokens) and tokens[segment_end][0] == "word":
            segment_end += 1

        words = [token[1] for token in tokens[index:segment_end]]
        next_op = tokens[segment_end][1] if segment_end < len(tokens) else None

        if words and words[0] == "cd":
            if len(words) != 2 or next_op not in {"&&", ";"}:
                print("raw")
                print(source)
                return
            index = segment_end + 1
            continue

        if is_assignment_segment(words):
            index = segment_end + 1
            continue

        if is_guarded_segment(words):
            # Only deny direct guarded invocations if there's a chain operator in the
            # command. A bare `gh pr create` invocation is handled by the prefix-rewrite
            # guardrail (which prepends [agento] to the title). A bare `gh pr merge` is
            # handled by the bash merge_pattern fallback.
            if next_op is not None or index > 0:
                print("deny")
                print(GUARDED_REDACTED_INLINE)
                return
            # Direct guarded command: fall through to the prefix-rewrite / merge_pattern
            # guards in the bash script.
            if first_safe_payload is None:
                first_safe_payload = source[tokens[index][2]:]
            break

        if first_safe_payload is None:
            first_safe_payload = source[tokens[index][2]:]

        if next_op is not None:
            index = segment_end + 1
            if remaining_segments_contain_guarded(tokens, segment_end + 1):
                print("deny")
                print(GUARDED_REDACTED_INLINE)
                return
            continue

        break

    if first_safe_payload is not None:
        print("safe")
        print(first_safe_payload)
        return

    print("raw")
    print(source)


if __name__ == "__main__":
    main()
