---
name: ao-lifecycle-triage
description: Use when AO lifecycle backfill cannot claim a PR because git reports a branch is already checked out in the main repository or a stale worktree.
---

# Canonical skill reference

Canonical instructions: `skills/ao-lifecycle-triage/SKILL.md` in this repository.

Before taking any task action:

1. Resolve the repository root with `git rev-parse --show-toplevel`.
2. Read the canonical file completely.
3. Follow it as the complete skill instructions.
4. Resolve relative references and bundled resources from `skills/ao-lifecycle-triage/`.

This `.agents` file contains discovery metadata only. Do not add an independent workflow here or allow it to drift from the repository canonical skill.
