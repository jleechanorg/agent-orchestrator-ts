---
title: Agent Docs Index
purpose: Router for task-oriented agent context loading.
owner: jleechan
last_reviewed: 2026-04-02
source_of_truth: This file
---

# Agent Docs Index

Read this first, then only open the leaf docs needed for your task.

## Reading order
- Architecture changes → `docs/agent/architecture.md`
- Behavior/spec changes → `docs/agent/specs.md`
- Current priorities → `docs/agent/plans.md`
- Test/merge standards → `docs/agent/quality.md`
- Runtime/debugging → `docs/agent/reliability.md`
- Security/trust boundaries → `docs/agent/security.md`

## Invariants
- Keep `AGENTS.md` short; durable details live in `docs/agent/*`.
- Update `last_reviewed` when modifying any leaf doc.
- Run `python3 scripts/agent_repo_check.py` before opening PRs that touch agent docs.
