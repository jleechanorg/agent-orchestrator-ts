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
gh pr list --state open --limit 100 --json number,title,mergeable,reviewDecision,headRefOid,statusCheckRollup,updatedAt --jq '.[] | . as $pr | "\(.number) | \(.title) | mergeable=\(.mergeable) | review=\(.reviewDecision) | ci=\((.statusCheckRollup // []) | map(select(.headSha == $pr.headRefOid)) | map(.conclusion) | group_by(.) | map({(.[0] // "pending"): length}) | add) | failed=\((.statusCheckRollup // []) | map(select(.headSha == $pr.headRefOid)) | map(. as $check | select(($check.conclusion // "") | ascii_upcase as $c | ["FAILURE","TIMED_OUT","ERROR","CANCELLED","ACTION_REQUIRED","STALE","STARTUP_FAILURE"] | index($c) != null and (($check.name // "") | test("Skeptic Gate"; "i") | not))) | length) | skeptic=\((.statusCheckRollup // []) | map(select(.headSha == $pr.headRefOid)) | map(. as $check | select(($check.name // "") | test("Skeptic Gate"; "i") and (($check.conclusion // "") | ascii_upcase as $c | ["FAILURE","TIMED_OUT","ERROR","CANCELLED","ACTION_REQUIRED","STALE","STARTUP_FAILURE"] | index($c) != null))) | length) | pending=\((.statusCheckRollup // []) | map(select(.headSha == $pr.headRefOid)) | map(select((.conclusion // "") == "")) | length) | \(.updatedAt[:10])"'
```

> **Note:** `--limit 100` covers repos with up to 100 open PRs. If your repo has more, increase the limit or paginate with `--jq` cursor-based fetching.

The `failed=N` count excludes Skeptic Gate checks (they are self-referential and tracked separately as `skeptic=N`). Use `failed=N` for Step 2 classification (needs-fix = failed > 0), and `skeptic=N` for skeptic-specific triage.

**Mandatory.** Do this BEFORE any single-PR work. No exceptions.

### Step 2 — Classify each PR

| Category | Criteria | Action |
|----------|----------|--------|
| **merge-ready** | All 7-green gates: CI green (pending=0) + mergeable + review APPROVED + Bugbot clean + inline threads resolved + evidence authentic + same-head Skeptic PASS | Run full 7-green verification then merge |
| **needs-fix** | CI red (failed > 0), review CHANGES_REQUESTED, or skeptic FAIL | Spawn parallel AO worker per PR |
| **blocked** | CONFLICTING, depends on another PR, or external blocker | Log blocker, skip for now |
| **stale** | No activity >7 days | Close or ping owner |

### Step 3 — Spawn parallel AO workers

For each **needs-fix** PR that is independent (no mutual dependencies), spawn an AO worker per PR. The DRIVER-mode contract is conveyed via the **spawn prompt**, not a CLI flag — `ao spawn` has no `--driver` option today (verified: `packages/cli/src/commands/spawn.ts:287` registers `--claim-pr` and the other existing options, no `--driver` exists):

```text
# Default one-shot dispatch (worker exits after one fix attempt):
ao spawn --claim-pr N  "fix PR N: <specific failure>"

# DRIVER mode — worker owns the PR until 7-green is confirmed:
# Pass the DRIVER mode contract in the prompt itself. The worker is told to
# iterate, not exit, and to apply the fix-all invariant below.
ao spawn --claim-pr N  "DRIVER MODE: take ownership of PR N and iterate until
                       ALL 7-green gates pass (CI green + CR APPROVED + Skeptic
                       PASS). See DRIVER mode contract in .claude/commands/babysit.md.
                       Apply the fix-all invariant — fix ALL outstanding issues in
                       ONE commit. Do not exit until done or explicitly blocked."
```

**Rules:**
- Spawn ALL independent fix workers in parallel (one `ao spawn` per PR)
- Pass PR number, current specific failure (CI test name, review thread, skeptic gate) as a starting hint, and the fix scope. The fix-all invariant below still applies — "specific failure" is the FIRST thing to look at, not the ONLY thing to fix.
- AO manages worktree creation, session metadata, and CI monitoring automatically
- Max 5 concurrent workers to avoid context explosion

### Fix-all invariant (mandatory for all PR workers)

Every worker spawned by babysit MUST apply the fix-all invariant — this OVERRIDES the older "one specific failure per push" pattern:

Before making ANY edits to a PR:
1. Collect ALL outstanding issues: CI test failures, CR review comments, Skeptic Gate findings, Bugbot errors, unresolved threads
2. Fix ALL of them in a SINGLE commit
3. Push ONCE
4. Wait for all bots to settle (CI, CR, Bugbot, Skeptic)
5. Re-survey — if new issues appeared, repeat from step 1

Why one-at-a-time is banned: each partial push triggers a full CI run (~5-15 min) and resets CR/Skeptic. A 5-issue PR fixed one-at-a-time = 5 CI runs = 25-75 min. Fixed in one batch = 1 CI run = 5-15 min.

Exception: merge conflicts must be resolved before other fixes (they block the push); resolve conflict first, then batch remaining fixes in the same commit.

Note: the "specific failure" hint passed to the worker is a starting point for triage, not a scope limit. The fix-all invariant requires the worker to enumerate ALL failures before editing — a single CR comment passed in the prompt does not authorize a single-CR-comment fix.

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
