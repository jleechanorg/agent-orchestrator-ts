---
title: Agent Quality
purpose: Define mechanical checks and commands for agent-facing doc hygiene.
owner: jleechan
last_reviewed: 2026-04-02
source_of_truth: scripts/agent_repo_check.py + CI workflows
---

# Quality

## Read this when
- updating docs/agent/*
- modifying AGENTS routing
- changing evidence requirements

## Required checks
- `python3 scripts/agent_repo_check.py`
- workflow syntax validity for changed `.github/workflows/*.yml`

## Must stay true
- `docs/agent/index.md` references every active leaf doc.
- Leaf docs contain required frontmatter keys.
- `AGENTS.md` points to `docs/agent/index.md` and `scripts/agent_repo_check.py`.
