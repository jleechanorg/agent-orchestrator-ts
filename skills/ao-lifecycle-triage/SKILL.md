---
name: ao-lifecycle-triage
description: Use when AO lifecycle backfill cannot claim a PR because git reports a branch is already checked out in the main repository or a stale worktree.
---

# AO Lifecycle Backfill Claim Failure Triage

## When to use

When `lifecycle.backfill.claim_failed` errors appear in the lifecycle-worker log with:
`fatal: refusing to fetch into branch 'refs/heads/BRANCH' checked out at 'PATH'`

## Two distinct root causes (same error surface)

### Cause A: Main repo on wrong branch

**Symptom**: `checked out at '/Users/jleechan/project_agento/agent-orchestrator-ts'`
**Diagnosis**: `git -C /Users/jleechan/project_agento/agent-orchestrator-ts branch --show-current`
**Fix**:

```bash
git -C /Users/jleechan/project_agento/agent-orchestrator-ts checkout main
git -C /Users/jleechan/project_agento/agent-orchestrator-ts pull --ff-only
```

**Why it happens**: An AO agent (or manual work) checked out a feature branch in the main repo and was killed before resetting to main.

### Cause B: Ghost worktrees (dead AO worktrees with branches still checked out)

**Symptom**: `checked out at '/Users/jleechan/.worktrees/agent-orchestrator/ao-NNN'`
**Diagnosis**: `git worktree list | grep ao-NNN` — if present with no live tmux session, it's a ghost
**Fix**:

```bash
tmux has-session -t bb5e6b7f8db3-ao-NNN 2>/dev/null || echo "Dead"
git worktree remove --force /Users/jleechan/.worktrees/agent-orchestrator/ao-NNN
```

**Why it happens**: AO session was killed without proper cleanup; worktree remained. The lifecycle-worker's `sweepOrphanWorktrees` auto-cleans after 6h TTL.

## Triage order (always check A first)

1. Look at the path in the error: if it's the main repo path → Cause A
2. If it's `~/.worktrees/...` → Cause B
3. If backfill is aborted (`claim_failed_abort` after 3 consecutive failures), check both

## Prevention

- `sweepOrphanWorktrees` in lifecycle-worker.ts runs every 5min (orphan TTL: 6h)
- Agents should always reset main repo to `main` before exiting

## Harness note

Ghost worktree accumulation cleaned manually twice in the same session on 2026-03-24 — this is the harness-level fix. If seeing this pattern again, the `orphanTtlMs` may need reduction.
