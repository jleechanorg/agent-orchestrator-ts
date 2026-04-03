#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from datetime import date
import re
import sys

REQUIRED_DOCS = [
    "docs/agent/index.md",
    "docs/agent/architecture.md",
    "docs/agent/specs.md",
    "docs/agent/plans.md",
    "docs/agent/quality.md",
    "docs/agent/reliability.md",
    "docs/agent/security.md",
]

REQUIRED_KEYS = ["title", "purpose", "owner", "last_reviewed", "source_of_truth"]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_frontmatter(text: str) -> dict[str, str] | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end == -1:
        return None
    fm = text[4:end].splitlines()
    out: dict[str, str] = {}
    for line in fm:
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def is_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def main() -> int:
    repo = Path.cwd()
    errors: list[str] = []

    for rel in REQUIRED_DOCS:
        p = repo / rel
        if not p.exists():
            errors.append(f"missing required doc: {rel}")
            continue
        text = read_text(p)
        fm = parse_frontmatter(text)
        if fm is None:
            errors.append(f"missing/invalid frontmatter: {rel}")
            continue
        for key in REQUIRED_KEYS:
            if not fm.get(key):
                errors.append(f"frontmatter key '{key}' missing in {rel}")
        lr = fm.get("last_reviewed", "")
        if lr and not is_iso_date(lr):
            errors.append(f"invalid last_reviewed date in {rel}: {lr}")

    idx = repo / "docs/agent/index.md"
    if idx.exists():
        body = read_text(idx)
        for rel in REQUIRED_DOCS:
            if rel.endswith("index.md"):
                continue
            leaf = rel.split("docs/agent/")[-1]
            if leaf not in body:
                errors.append(f"index missing reference to {leaf}")

    agents = repo / "AGENTS.md"
    if agents.exists():
        atext = read_text(agents)
        if "docs/agent/index.md" not in atext:
            errors.append("AGENTS.md missing pointer to docs/agent/index.md")
        if "scripts/agent_repo_check.py" not in atext:
            errors.append("AGENTS.md missing pointer to scripts/agent_repo_check.py")
    else:
        errors.append("AGENTS.md missing")

    if errors:
        print("agent_repo_check: FAIL")
        for err in errors:
            print(f"- {err}")
        return 1

    print("agent_repo_check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
