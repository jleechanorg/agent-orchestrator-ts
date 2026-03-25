---
name: evolve_loop
aliases:
  - eloop
description: Autonomous evolution loop — observe AO ecosystem, measure zero-touch rate, diagnose friction, dispatch fixes. Adaptive — skips phases when system is healthy.
type: git
---

## EXECUTION INSTRUCTIONS FOR CLAUDE

Load and execute the skill at `~/.claude/skills/evolve_loop.md`.

**Key behavior**: This is an ADAPTIVE loop. Not every phase runs every cycle:
- If all workers are alive and PRs are progressing → just report status and wait
- If zero-touch rate hasn't changed and no new friction → skip diagnose/fix phases
- Only run /harness, /nextsteps, /claw when there's a NEW problem to solve
- Always measure (Phase 2) and always recap (Phase 7)

**To start the loop**: `/loop 10m /eloop` (runs every 10min, max 12h)
**Single cycle**: `/eloop`
