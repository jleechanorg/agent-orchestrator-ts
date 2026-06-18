---
name: babysit
description: Multi-PR triage — survey all open PRs, classify, and spawn parallel AO workers to bring them to green.
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
- `/babysit --driver N` — DRIVER mode: take ownership of PR N, iterate until ALL gates pass (CI green + CR APPROVED + Skeptic PASS). Does not exit until done or explicitly blocked.

## DRIVER mode contract

When a babysit-spawned AO worker is in DRIVER mode for PR N, it MUST:

1. Fix all outstanding issues in one batch — read ALL CR comments, ALL CI failures, ALL Skeptic findings BEFORE making any edits. Fix everything in a single commit. Never push after fixing one item and wait for CI to find the next.
2. Iterate until actually fixed — after each push, wait for CI + CR + Skeptic to settle, then re-survey. If new issues surface, fix all of them again in one batch. Repeat until all 7 green gates pass.
3. Never exit with "attempted" — "I tried X" is not done. The worker exits only when: (a) 7-green confirmed, or (b) blocked on a genuine external dependency (merge conflict with another PR, external service outage, explicit user instruction to stop).
4. Report blockers explicitly — if blocked, post: "BLOCKED: <exact reason> — needs: <what resolves it>". Never silent exit.
