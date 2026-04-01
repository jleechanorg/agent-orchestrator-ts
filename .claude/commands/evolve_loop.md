---
name: evolve_loop
description: Autonomous evolution loop — observe AO ecosystem, measure zero-touch rate, diagnose friction, dispatch fixes. Adaptive.
---

## EXECUTION INSTRUCTIONS FOR CLAUDE

Read and execute the skill at `.claude/skills/evolve_loop.md`.

This command runs ONE cycle of the evolution loop. The loop body is adaptive:
- If all workers are alive and PRs are progressing → just report status
- If zero-touch rate hasn't changed and no new friction → skip diagnose/fix phases
- Only run /harness, /nextsteps, /claw (or **`/antig`** when tmux cap blocks — see skill §Phase 6) when there's a NEW problem to solve
- Always measure zero-touch rate and always recap

Execute the 7 phases described in the skill file now.
