# Autonomy Blockers v2 — Spawn-to-6-Green Pipeline Gaps

**Audit date:** 2026-03-23
**Epic bead:** bd-ara
**Status:** OPEN — root causes identified, fixes proposed
**Prior art:** `roadmap/autonomy-gaps.md` (v1, 2026-03-15, IMPLEMENTED)

---

## Executive Summary

19 open PRs. 0 are 6-green. The autonomy pipeline (`ao spawn` → code → PR → 6 green → merge) has 5 systemic blockers. v1 closed the merge-gate and reaction plumbing gaps. v2 addresses the **last-mile failures** that prevent workers from actually reaching green.

| # | Blocker | Impact | Root Cause | Fix Type |
|---|---------|--------|------------|----------|
| 1 | Unresolved inline comments | 19/19 PRs blocked | `autoResolveThreads()` is dead code; workers don't document fixes | ✅ Config (agentRules) — RESOLVED |
| 2 | `mergeable=UNKNOWN` | 13/19 PRs | No reaction for UNKNOWN; workers only rebase on CONFLICTING | Config + lifecycle event |
| 3 | Stale session accumulation | 25 tmux sessions (gate=15) | No kill signal on PR merge; reaper too slow | Core code (lifecycle-manager) |
| 4 | CHANGES_REQUESTED stuck | 8/19 PRs | Workers fix code but don't trigger CR re-review | Config (agentRules) + hook |
| 5 | Test failures not self-healed | 3/19 PRs | ci-failed reaction lacks test output; no local-first rule | Config + reaction context |

---

## Blocker 1: Workers Don't Clear Unresolved Comments (bd-ara.1)

**Status:** ✅ RESOLVED — 2026-03-23 (session ao-611)
**Implementation:** `~/.openclaw/agent-orchestrator.yaml` defaults.agentRules — GraphQL thread resolution removed; replaced with PR description documentation approach.
**Artifact:** `roadmap/autonomy-blockers-v2.md` (this file)

**Observed:** Even CR-APPROVED PRs have 1-14 unresolved review threads. Green condition #5 (all comments resolved) never passes.

### 5 Whys — Technical

1. **Why are threads unresolved?** Workers fix the code but never resolve the GitHub review threads.
2. **Why don't workers resolve threads?** `autoResolveThreads()` exists in `auto-resolve-threads.ts` but is **never called** — it's exported from `index.ts` but no lifecycle or reaction code invokes it.
3. **Why isn't it wired in?** It was implemented as a standalone utility (bd-xj8) but integration into the lifecycle was never completed.
4. **Why wasn't integration completed?** GraphQL thread resolution burns rate limit and has edge cases (resolving threads the worker didn't actually fix).
5. **Why is rate limit a concern?** Each resolution is a separate GraphQL mutation; with 10+ threads per PR × 19 PRs, that's 190+ mutations per cycle.

→ **Root cause:** `autoResolveThreads()` is dead code; no cheap alternative was implemented.

### 5 Whys — Agent Path

1. **Why don't workers resolve threads on their own?** agentRules say "fix all actionable items" but never say "document which comments you resolved."
2. **Why don't agentRules cover this?** The instructions focus on *fixing code* not *closing the feedback loop*.
3. **Why wasn't the feedback loop documented?** v1 assumed resolving threads was the platform's job (autoResolveThreads), not the agent's.
4. **Why did agents never learn this?** No feedback memory or skill teaches "after fixing a CR comment, document it."
5. **Why is the harness incomplete here?** The green condition check (merge-gate) counts unresolved threads but nothing in the agent's workflow tells it how to get that count to zero.

→ **Agent root cause:** Instructions tell workers to fix code but never to document which review comments are addressed.

### Proposed Fix — /copilot-style PR Description Documentation

**Instead of GraphQL thread resolution**, workers document resolved comments in the PR description:

```markdown
## Resolved Comments
| Reviewer | File | Comment | Resolution |
|----------|------|---------|------------|
| coderabbitai[bot] | src/foo.ts:42 | "Missing null check" | Added null guard (commit abc123) |
| copilot[bot] | src/bar.ts:10 | "Unused import" | Removed (commit abc123) |
```

**Implementation:**
1. **[Config]** Add to agentRules: "After fixing review comments, append a '## Resolved Comments' table to the PR description listing each comment, file, and how you resolved it. Use `gh pr edit --body` to update."
2. **[Config]** Update merge-gate condition #5: instead of requiring `unresolvedThreads === 0`, check that all Major/Critical comments have a matching entry in the PR description's Resolved Comments table.
3. **[Bead bd-xj8]** Repurpose: close as "won't fix (GraphQL approach)" and reference bd-ara.1 as the replacement.

**Cost:** Zero GraphQL mutations. Workers already read comments; they just need to write a table.

---

## Blocker 2: `mergeable=UNKNOWN` on Most PRs (bd-ara.2)

**Observed:** 13/19 PRs show `mergeable: UNKNOWN`. GitHub hasn't computed mergeability because branches are stale (no recent push).

### 5 Whys — Technical

1. **Why is mergeable UNKNOWN?** GitHub only computes merge status when the branch has recent activity or is viewed in the UI.
2. **Why don't branches have recent activity?** Workers push a fix, then wait for CI. If CI passes but no new push happens, the merge check expires.
3. **Why doesn't the lifecycle react?** The `merge-conflicts` reaction only fires when `mergeReady.noConflicts === false` — but UNKNOWN isn't false, it's undefined/null.
4. **Why isn't UNKNOWN handled?** The status mapping treats UNKNOWN as "not yet computed" and skips it, waiting for the next poll.
5. **Why doesn't polling resolve it?** Polling reads the GitHub API, but reading doesn't trigger GitHub to recompute mergeability — only a push or UI view does.

→ **Root cause:** No mechanism forces GitHub to recompute mergeability for stale branches.

### 5 Whys — Agent Path

1. **Why don't workers rebase stale branches?** agentRules only mention rebase "if merge conflicts" — UNKNOWN isn't conflicts.
2. **Why don't agents check mergeability proactively?** The approved-and-green reaction checks mergeability but the worker has no instruction for what to do when it's UNKNOWN.
3. **Why is there no UNKNOWN instruction?** v1 focused on CONFLICTING and MERGEABLE as the two states; UNKNOWN was overlooked.

→ **Agent root cause:** No instruction or reaction exists for the UNKNOWN mergeability state.

### Proposed Fix

1. **[Config]** Add to agentRules: "If `gh pr view --json mergeable --jq .mergeable` returns UNKNOWN, run `git fetch origin && git rebase origin/main && git push --force-with-lease` to trigger GitHub merge check recomputation."
2. **[Lifecycle]** Add `mergeable-unknown` event in lifecycle-manager alongside `merge-conflicts`. When mergeability is UNKNOWN for >5 minutes, emit event with `send-to-agent` reaction: "Branch is stale. Rebase on main to trigger merge check."
3. **[Config]** Add reaction:
   ```yaml
   mergeable-unknown:
     auto: true
     action: send-to-agent
     message: "PR mergeability is UNKNOWN (stale branch). Rebase: git fetch origin && git rebase origin/main && git push --force-with-lease"
   ```

---

## Blocker 3: Stale Sessions Accumulate Past Spawn Gate (bd-ara.3)

**Observed:** 25 active tmux sessions. Spawn gate is 15. New workers can't be spawned.

### 5 Whys — Technical

1. **Why are there 25 sessions?** Sessions for merged/closed PRs stay alive as tmux processes.
2. **Why aren't they killed on merge?** `lifecycle-manager.ts` transitions session status to `merged` but **never calls `runtime.kill()`** (bd-s4t).
3. **Why doesn't the reaper clean them?** Reaper skips sessions with `TERMINAL_STATUSES` (which includes `merged`) — it assumes terminal-status sessions are already dead.
4. **Why is that assumption wrong?** Status is tracked in AO metadata, but the tmux process is independent. Setting status=merged doesn't kill the tmux session.
5. **Why is there a gap between metadata and process?** The original design assumed agents would self-terminate when done. They don't — they keep looping.

→ **Root cause:** No code path kills the tmux process when a PR merges. Metadata and process lifecycle are disconnected.

### 5 Whys — Agent Path

1. **Why don't agents exit when their PR merges?** agentRules say "if PR is MERGED or CLOSED, exit immediately" but the agent must discover this on its own poll.
2. **Why don't agents poll their PR state?** They do, but the polling interval is long and agents sometimes get stuck in fix loops.
3. **Why doesn't the orchestrator force-kill?** The kill-on-merge path was never implemented (bd-s4t).

→ **Agent root cause:** Agent self-exit is unreliable; the platform must enforce it.

### Proposed Fix

1. **[Core]** In `lifecycle-manager.ts`, when `newStatus === "merged"` or PR state is `merged`/`closed`, call `runtime.kill(session)` immediately after status transition.
2. **[Core]** In `session-reaper.ts`, add a new kill condition: if `session.pr?.state === "merged" || session.pr?.state === "closed"`, kill regardless of session status.
3. **[Config]** Increase `maxKillsPerRun` from 5 to 15, or make it configurable in `agent-orchestrator.yaml`.
4. **[Related]** bd-s4t, bd-s4t.1, bd-s4t.2 all describe this same root cause.

---

## Blocker 4: CHANGES_REQUESTED PRs Don't Recover (bd-ara.4)

**Observed:** 8/19 PRs stuck in CHANGES_REQUESTED review state. Workers push fixes but the review state never flips to APPROVED.

### 5 Whys — Technical

1. **Why doesn't review state flip after fix?** Workers push code fixes but don't always post `@coderabbitai all good?` to trigger re-review.
2. **Why don't workers post the trigger comment?** The "MANDATORY AFTER EVERY PUSH" rule in agentRules is on line ~72 of a 200+ line block — workers may not parse it.
3. **Why is the rule buried?** agentRules grew organically; critical rules compete with boilerplate for LLM attention.
4. **Why do LLMs miss buried rules?** Long system prompts suffer from "lost in the middle" effect — rules near the top and bottom get more attention than rules in the middle.
5. **Why haven't we mitigated this?** No post-push hook exists to auto-post the CR trigger.

→ **Root cause:** Critical post-push instruction is buried in overly long agentRules; no automated fallback.

### 5 Whys — Agent Path

1. **Why do workers fix the wrong thing?** Workers sometimes do tangential cleanup instead of the specific CR comment.
2. **Why?** The changes-requested reaction message says "Address each comment" but doesn't quote the specific comment text.
3. **Why doesn't it quote?** The `{{context}}` template in the reaction does inject comment previews, but only the first 5 — if the specific blocker is #6+, the worker misses it.
4. **Why only 5?** `reaction-context.ts` line 41: `comments.slice(0, 5)` — hardcoded limit.
5. **Why was it limited?** To keep message size manageable. But this causes workers to miss the actual blocker when there are many comments.

→ **Agent root cause:** Reaction context truncates comments, causing workers to fix the wrong ones; post-push CR trigger is buried in long instructions.

### Proposed Fix

1. **[Config]** Add a post-push hook (or agentRules at the TOP, not buried): "IMMEDIATELY after every git push, run: `gh pr comment <PR> --body '@coderabbitai all good?'`"
2. **[Core]** In `reaction-context.ts`, increase `comments.slice(0, 3)` to `comments.slice(0, 10)` — most PRs have <10 unresolved comments.
3. **[Config]** Restructure agentRules: move the 5 most critical rules to the top, move boilerplate to a linked skill/command.
4. **[Config]** Add to agentRules: "When fixing CR comments, read the EXACT comment text first. Fix ONLY what was requested. Do not do tangential cleanup."

---

## Blocker 5: Test Failures Not Self-Healed (bd-ara.5)

**Observed:** PRs #99, #79, #67 have failing `Test` check. Workers receive `ci-failed` reaction but don't fix the tests.

### 5 Whys — Technical

1. **Why don't workers fix the test?** Workers push a "fix" but CI fails again on the same or a different test.
2. **Why does the fix not work?** Workers don't run the failing test locally before pushing — they guess at the fix.
3. **Why don't they run tests locally?** agentRules say "run pnpm test before pushing" but workers skip this under time pressure or context limits.
4. **Why is the local-test rule not enforced?** No pre-push hook verifies that tests passed. It's purely advisory.
5. **Why isn't there a pre-push hook?** AO agent hooks are PostToolUse observers (v1 finding 4xzz) — they can't block pushes.

→ **Root cause:** No enforcement mechanism ensures workers run tests locally before pushing. Workers guess at fixes without verifying.

### 5 Whys — Agent Path

1. **Why do workers guess at test fixes?** The ci-failed reaction message says "Fix the failing checks" but doesn't include the test output.
2. **Why no test output?** `reaction-context.ts` injects check names and status URLs but not the actual failure log.
3. **Why not the failure log?** GitHub Actions logs require a separate API call to download; the reaction context builder doesn't fetch them.
4. **Why wasn't log fetching added?** It would burn additional API calls per CI failure notification.

→ **Agent root cause:** ci-failed reaction lacks test output; workers lack information to make targeted fixes.

### Proposed Fix

1. **[Config]** Add to agentRules (top): "When CI test fails, ALWAYS run the failing test locally FIRST: `pnpm -C packages/core test -- --reporter verbose 2>&1 | tail -50`. Only push after the test passes locally."
2. **[Core]** Enhance `reaction-context.ts` ci-failed context: after listing failing checks, add: "Run locally to see output: `pnpm test`" (cheaper than fetching GH logs).
3. **[Config]** Add retry budget to ci-failed reaction: `retries: 3` (already present) but add agentRules: "If you've pushed 3 fixes for the same test failure and it still fails, stop and send MCP mail with subject 'Escalation: test failure after 3 fix attempts'."

---

## Cross-Cutting Harness Gaps

### Gap A: agentRules are too long (~200 lines)

The single `agentRules` field in `agent-orchestrator.yaml` carries ~200 lines of instructions. LLMs suffer from "lost in the middle" — critical rules in the middle are deprioritized.

**Fix:** Split agentRules into:
- **Core rules (top 20 lines):** commit prefix, never merge, test before push, CR trigger after push
- **Slash command references:** "For CR resolution: run /copilot. For CI failures: run /fixpr."
- **Full protocol docs:** Move to linked skills (`~/.claude/skills/`) that workers invoke on-demand

### Gap B: REST fallback treats ALL comments as unresolved

When GraphQL is rate-limited, `getPendingComments()` falls back to REST (`repos/{owner}/{repo}/pulls/{number}/comments`). The REST API has **no `isResolved` field**, so the fallback treats ALL comments as unresolved — even ones the worker already fixed. This means merge-gate condition #5 always fails during GraphQL rate-limit windows. The PR-description approach (bd-ara.1) would bypass this entirely since it doesn't depend on GitHub's thread resolution state.

### Gap C: autoResolveThreads is dead code

`packages/core/src/auto-resolve-threads.ts` is fully implemented and tested but never called. Either:
- Wire it into lifecycle-manager as a post-push reaction, OR
- Delete it and use the PR-description approach (bd-ara.1) instead

### Gap C: Reaper is too conservative

`maxKillsPerRun: 5` with a nightly schedule means it takes 5+ days to clean up a batch of 25 stale sessions. Either increase the cap or run more frequently.

### Gap D: No post-push automation

Workers must manually remember to post `@coderabbitai all good?` after every push. This should be a hook or automated reaction, not an instruction.

---

## Priority Order

```
bd-ara.3 (kill sessions on merge)  ← unblocks spawn gate immediately
  └─ depends on: nothing (core code change)

bd-ara.4 (CR recovery)            ← unblocks 8 PRs
  └─ depends on: nothing (config change)

bd-ara.1 (comment documentation)  ← unblocks green condition #5
  └─ depends on: nothing (config change)

bd-ara.2 (mergeable=UNKNOWN)      ← unblocks 13 PRs
  └─ depends on: nothing (config + optional lifecycle event)

bd-ara.5 (test self-heal)         ← unblocks 3 PRs
  └─ depends on: nothing (config change)
```

**Suggested order:** bd-ara.3 → bd-ara.4 → bd-ara.1 → bd-ara.2 → bd-ara.5

Most fixes are **config-only** (agentRules changes). Only bd-ara.3 requires core code changes.
