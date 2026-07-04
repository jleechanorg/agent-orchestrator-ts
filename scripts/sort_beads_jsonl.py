#!/usr/bin/env python3
"""Canonicalize .beads/issues.jsonl by id ascending.

ROOT CAUSE FIX for the +1686/-1685 noise pattern (worldai PR #7848 etc.).
Wire into a pre-commit hook (see install-beads-hook.sh) so the JSONL is
canonicalized before every commit.

Standalone:
  python3 scripts/sort_beads_jsonl.py
"""
import json, sys
from pathlib import Path
JSONL = Path(".beads") / "issues.jsonl"
def main():
    if not JSONL.exists(): return 0
    text = JSONL.read_text(encoding="utf-8")
    beads = []
    for line in text.splitlines():
        if not line.strip(): continue
        try: beads.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"error: malformed JSONL: {e}", file=sys.stderr); return 1
    if not beads: return 0
    if [b["id"] for b in beads] == sorted(b["id"] for b in beads):
        print(f"sort-beads-jsonl: {len(beads)} beads already sorted"); return 0
    beads.sort(key=lambda b: b["id"])
    tmp = JSONL.with_suffix(".jsonl.tmp")
    tmp.write_text("".join(json.dumps(b) + "\n" for b in beads), encoding="utf-8")
    tmp.replace(JSONL)
    print(f"sort-beads-jsonl: rewrote {len(beads)} beads in id-ascending order")
    return 0
if __name__ == "__main__": sys.exit(main())
