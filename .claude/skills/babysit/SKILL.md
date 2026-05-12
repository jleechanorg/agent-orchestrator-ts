---
name: babysit
description: Multi-PR triage and parallel work dispatcher. Prevents single-PR tunnel vision by enforcing a survey-before-deep-dive protocol.
---

# babysit — Multi-PR Triage & Parallel Dispatch

Prevents the most common agent failure: spending an entire session on one PR while other PRs rot.

## When to use

- Session start (always, if repo has open PRs)
- After resuming from context compaction
- When the user says "bring PRs to green" or similar
- Any time you catch yourself iterating on a single PR for >15 minutes without checking others

## Protocol

### Step 1 — Survey ALL open PRs

```bash
gh pr list --state open --json number,title,mergeable,reviewDecision,statusCheckRollup,updatedAt --jq '.[] | "\(.number) | \(.title) | mergeable=\(.mergeable) | review=\(.reviewDecision) | ci=\(.statusCheckRollup | map(.conclusion) | group_by(.) | map({(.[0] // "pending"): length}) | add) | failed=\(.statusCheckRollup | map(select(.conclusion == "failure")) | length) | \(.updatedAt[:10])"'
```

The `failed=N` count is used directly in Step 2 classification (needs-fix = failed > 0).

**Mandatory.** Do this BEFORE any single-PR work. No exceptions.

### Step 2 — Classify each PR

| Category | Criteria | Action |
|----------|----------|--------|
| **merge-ready** | Mergeable + review APPROVED + CI green | Merge (or verify 7-green then merge) |
| **needs-fix** | CI red, review CHANGES_REQUESTED, or skeptic FAIL | Spawn parallel AO worker per PR |
| **blocked** | CONFLICTING, depends on another PR, or external blocker | Log blocker, skip for now |
| **stale** | No activity >7 days | Close or ping owner |

### Step 3 — Spawn parallel AO workers

For each **needs-fix** PR that is independent (no mutual dependencies), spawn an AO worker per PR:

```text
ao spawn --claim-pr N  // one per PR, uses AO worker model
```

**Rules:**
- Spawn ALL independent fix workers in parallel (one `ao spawn` per PR)
- Each worker gets: PR number, specific failure (CI test name, review thread, skeptic gate), and the fix scope
- AO manages worktree creation, session metadata, and CI monitoring automatically
- Max 5 concurrent workers to avoid context explosion

### Step 4 — Monitor and collect

- Wait for workers to complete (they auto-notify)
- Collect results, push fixes, re-trigger CI
- Re-survey after batch completes to catch newly unblocked PRs

### Step 5 — Escalate stuck PRs

If a PR needs >30 minutes of your own direct work:
1. Stop. Re-survey. Are other PRs getting neglected?
2. If yes, spawn an AO worker for the stuck PR and move on
3. If no, continue but set a 15-minute check-in timer

## Anti-patterns (DO NOT)

- ❌ Spend entire session on one PR without surveying others
- ❌ Run `ao skeptic verify` serially on each PR — parallelize
- ❌ Fix one gate, push, wait, fix next gate — batch fixes before pushing
- ❌ Treat a context-resume summary as a single-PR task queue

## Why this exists

Session 2026-05-12: 9 open PRs, entire session spent on #548 serially (6 commit/push/skeptic cycles). The "prefer parallel workers" rule was advisory, not procedural. This skill makes the triage+dispatch protocol mandatory.
