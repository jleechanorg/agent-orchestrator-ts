---
title: Agent Specs
purpose: Capture behavior requirements that are enforced by policy/gates.
owner: jleechan
last_reviewed: 2026-04-02
source_of_truth: CLAUDE.md + workflows
---

# Specs

## Read this when
- changing workflow gates
- adding claim classes or evidence rules
- modifying merge-gate logic

## Must stay true
- Claim classes are explicit and validated fail-closed.
- Strong evidence for non-unit claims includes media + execution output + self-validation.
- Verdict must be present in `## Evidence`.
