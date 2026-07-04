#!/usr/bin/env python3
"""Bead JSONL sort-order invariant check.

Run in CI:
  python3 scripts/check_bead_jsonl_sort.py

Exit code 0 = sorted, exit code 1 = out-of-order or unparseable.
"""

import json, sys
from pathlib import Path

JSONL = Path(".beads") / "issues.jsonl"


def main() -> int:
    if not JSONL.exists():
        print(f"::notice::{JSONL} not present; skipping")
        return 0
    text = JSONL.read_text(encoding="utf-8")
    ids, errors = [], []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.strip(): continue
        try:
            ids.append(json.loads(line)["id"])
        except (json.JSONDecodeError, KeyError) as e:
            errors.append(f"line {lineno}: {e}")
    if errors:
        sample = "; ".join(errors[:5])
        print(f"::error title=Bead JSONL parse errors::{len(errors)} malformed line(s): {sample}")
        return 1
    if not ids:
        print("::notice::JSONL has no records")
        return 0
    if ids == sorted(ids):
        print(f"OK: {len(ids)} beads sorted by id ascending")
        return 0
    inversions = [(ids[i], ids[i+1]) for i in range(len(ids)-1) if ids[i] > ids[i+1]][:5]
    summary = ", ".join(f"{a!r} > {b!r}" for a, b in inversions)
    print(f"::error title=Bead JSONL sort-order violation::{len(ids)} beads, first inversions: {summary}.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
