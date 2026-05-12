---
name: babysit
description: Multi-PR triage — survey all open PRs, classify, and spawn parallel subagents to bring them to green.
---

# /babysit — Bring all PRs to green

Invoke the babysit skill protocol:

1. **Survey**: List all open PRs with `gh pr list --state open`
2. **Classify**: Sort into merge-ready / needs-fix / blocked / stale
3. **Dispatch**: Spawn parallel AO workers for all independent needs-fix PRs
4. **Monitor**: Collect results, push fixes, re-survey

See `.claude/skills/babysit/SKILL.md` for full protocol.

## Arguments

- `/babysit` — Full survey + dispatch
- `/babysit --status` — Survey only, no dispatch (just report classification)
- `/babysit --fix N` — Deep-dive on specific PR N (after survey)
