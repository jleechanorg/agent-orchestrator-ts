---
name: pr-driver-protocol
description: "Use after every `git push` on a PR — enumerates ALL current gate failures, fixes ALL in one local pass, and pushes once. The fix-all-before-push invariant. Pairs with the CLAUDE.md PR driver loop contract and babysit DRIVER mode."
---

# PR driver protocol — fix-all before push (bd-snx3)

A standalone, callable protocol for any agent (worker, babysit, human) that is driving a PR to green. The single rule: **after every push, fix ALL known gate failures in one local pass before the next push**. "CI pending" is not an idle state.

## When to use this protocol

- You just pushed a commit and need to wait for CI to come back
- You see the same gate failure 2+ times in a row (worker or babysit perspective)
- You are babysitting a worker that appears to be partial-fixing
- You are tempted to do "one quick fix and re-push" — **stop, run this protocol first**

## The 5-step loop

```text
1. ENUMERATE   — read ALL current gate failures, not just the first
2. CLASSIFY    — group by file + root cause (same root cause = one fix)
3. FIX-ALL     — apply every fix locally; do not push until all are staged
4. VERIFY      — run the local equivalent of each failing gate
5. PUSH        — single commit covering all fixes; then back to step 1
```

### Step 1: ENUMERATE

Do not stop at the first failure. Use `/green <PR>` or read the `failure-class` log and build a complete list. For each failure, capture:

- **Gate name** (Green Gate, CodeRabbit, Skeptic, Evidence, Bugbot, inline threads)
- **File and line** (e.g., `packages/cli/src/doctor.ts:142`)
- **Failure text** (the actual error message, not a paraphrase)
- **Root cause hypothesis** (what is wrong, not just what is failing)

### Step 2: CLASSIFY

Group failures by the underlying root cause. Two failures with the same root cause are one fix:

```text
F1: dist/index.js argv shape not recognized in non-canonical check   (cli/doctor.ts:142)
F2: worker binary path resolution fails when global npm is used        (cli/doctor.ts:203)
  → Same root cause: argv path normalization is regex-naive
  → ONE fix: switch to path.basename() comparison
```

Do not push two commits to fix one root cause. The whole point of this protocol is to stop partial-fix-then-push loops.

### Step 3: FIX-ALL

Apply every fix in one local working tree. Stage selectively — **never `git add -A`**. The commit message should describe the bundle, not each individual fix:

```text
[agento] fix: doctor argv-path handling (resolves gate 1 + 2)

- cli/doctor.ts:142 use path.basename() instead of regex match
- cli/doctor.ts:203 accept '/path/dist/index.js' as canonical
- Test added in packages/cli/test/doctor.test.ts
```

### Step 4: VERIFY

Run the local equivalent of each failing gate **before** pushing:

| Gate | Local verification |
|---|---|
| Green Gate (CI) | `pnpm test` (and the relevant package test) |
| CodeRabbit | Read the diff once more: does each CR comment have an addressed counterpart? |
| Skeptic | `gh pr checks` — wait for Skeptic Gate to settle, then re-trigger via `/skeptic` comment |
| Evidence | Open the PR description: are all claims backed by a gist or media link? |
| Bugbot | Read the file change: is the bug fix actually verified? |
| Inline threads | `gh api graphql ... isResolved` — every thread resolved? |

If verification fails, **do not push**. Go back to step 3 with the new failures added to the list.

### Step 5: PUSH

One commit, one push, then immediately back to step 1 (the loop continues). While CI is running, **pre-diagnose the next likely failure** by reading:

- The previous run's tail (often the next failure is in the same area)
- Any CodeRabbit comments not yet addressed
- Any `ao skeptic verify` verdicts from prior runs

## Worked example: PR #7618 (rate-limit) — 3+ partial pushes, then 1 fix-all push

**Before this protocol (4h, 3+ pushes):**
- Push 1: fix `RATE_LIMIT_DAILY_TURNS=30` (only gate 1)
- Push 2: fix `RATE_LIMIT_5HOUR_TURNS=20` (only gate 2)
- Push 3: fix the cron re-arming bug (only gate 3)
- Result: 4h+ of CI round-trips, worker idle between each push

**With this protocol (1 push):**
- Step 1 ENUMERATE: 3 gate failures identified in a single pass — read all 3 failure logs at once
- Step 2 CLASSIFY: failures A and B are both "rate-limit constants" (one config change). Failure C is the cron-rearm logic (separate file)
- Step 3 FIX-ALL: edit `config/rate-limits.yaml` (A+B) and `lifecycle/cron.ts` (C) in the same working tree
- Step 4 VERIFY: `pnpm test` for `lifecycle/cron.test.ts` and `config/rate-limits.test.ts`
- Step 5 PUSH: single commit `[agento] fix: rate-limit constants + cron rearm`

## Anti-patterns (will be flagged by the harness)

- ❌ "Push one fix, wait, push another fix" — this is the failure mode
- ❌ `git add -A` to bundle fixes — staging must be selective per file
- ❌ Reading only the first failure in `gh pr checks` — always read the full list
- ❌ "CI pending, I'll wait and see" — CI pending is parallel-fix time, not idle time
- ❌ Generic `ao send` "fix CI" from babysit — DRIVER mode requires file:line + specific change
- ❌ "Let me first rebase, then fix, then push" — rebase is not a fix; do it after the fix-all is staged

## Pairing with babysit DRIVER mode

When running babysit against a worker that is using this protocol:

- Babysit observes the protocol's step 1-5 cycle in the worker's logs
- If the worker is stuck between steps (e.g., step 3 partial, did not advance to step 4), babysit's DRIVER mode fires and sends the next step's specific instruction
- The protocol is **worker-side** (this file); DRIVER mode is **observer-side** (`~/.claude/skills/babysit/SKILL.md`)

## Origin and evidence

- **Bead:** `bd-snx3`
- **Memory:** [[pr-driver-loop-contract]] (worker-side), [[babysit-not-a-driver]] (observer-side)
- **CLAUDE.md rule:** `~/.claude/CLAUDE.md` section "PR driver loop contract — fix-all before push"
- **Evidence PR:** [worldarchitect.ai #7618](https://github.com/jleechanorg/worldarchitect.ai/pull/7618) (rate-limit) — 3+ partial fix pushes over 4h before this protocol existed. Same pattern in PRs #7276, #7558, #7586, BQ wiring, #7420, wa-2246 (6+ PRs in 2 weeks).
- **Investigation:** 2026-06-18 /harness 5-whys
