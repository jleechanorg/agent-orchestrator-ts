# Green Loop E2E — Autonomous PR Lifecycle

**Epic**: bd-y5v
**Status**: In progress
**Date**: 2026-03-23

## Goal

The lifecycle-worker autonomously drives every open PR from creation to 6-green and merged, without human intervention.

## What "6-Green" Means

| # | Condition | How it's checked |
|---|---|---|
| 1 | CI passing | All GitHub Actions checks SUCCESS |
| 2 | No merge conflicts | mergeable: MERGEABLE |
| 3 | CodeRabbit APPROVED | Review state = APPROVED |
| 4 | Bugbot clean | Conclusion neutral/success |
| 5 | All inline comments resolved | No unresolved Major/Critical threads |
| 6 | Evidence review passed | /er returns PASS (if applicable) |

## Architecture

```
lifecycle-worker (poll every 30s)
  ├── checkSession() → determineStatus() → detect transitions
  ├── executeReaction() → send-to-agent / notify / auto-merge
  └── backfillUncoveredPRs() → list open PRs, spawn for uncovered (every 5 min)
```

The lifecycle-worker is the single autonomous loop. It does NOT require an orchestrator session, Claude Code session, or external poller.

## Components Required

### Implemented (PR #129)

| Component | Status | PR |
|---|---|---|
| `backfillAllPRs` in ProjectConfig type | Done | #129 |
| `backfillAllPRs` in Zod schema | Done | #129 |
| `listOpenPRs()` on SCM interface | Done | #129 |
| `listOpenPRs()` in scm-github plugin | Done | #129 |
| Backfill loop in lifecycle-manager | Done | #129 |
| Reaction observability logging | Done | #129 |

### Previously Merged (autonomy plumbing)

| Component | PR | Bead |
|---|---|---|
| Auto-merge pipeline | #120 | bd-ara |
| Tmux orphan session sweep | #122 | bd-jo6 |
| Stale worktree recovery | #121 | bd-xf5 |
| API retry storm prevention | #124 | - |
| Batch GraphQL for PR checks | #118 | bd-att |
| Ghost file self-healing | #111 | - |
| Dead-agent CLI detection | #108 | bd-tln |
| Resilient GraphQL executor | #104 | - |
| Rate-limit pause state | #103 | - |
| TTL cache + dedupe for gh API | #101 | - |
| Pre-spawn gate | #100 | - |

### Existing Open PRs to Merge (autonomy-critical)

These PRs fix specific autonomy blockers. Priority order for merging:

| PR | Title | Bead | Why needed |
|---|---|---|---|
| **#129** | backfillAllPRs implementation | bd-awq | **Core feature** — without this, dead sessions are never respawned |
| #114 | Dead-agent CLI detection + restart | bd-tln | `send-to-agent` fails on dead sessions; this restarts them |
| #109 | Adaptive delay + Enter retry for tmux send | bd-orch2v3, bd-qhf | Messages pasted to tmux but agent never sees Enter key |
| #99 | Kill zombie tmux sessions on merge | bd-s4t | Merged PRs leave zombie sessions consuming resources |
| #112 | Lock worktrees to prevent accidental prune | bd-diq | Workers lose workspace when worktree is cleaned |

### Agent-Prompt Approach (not more TypeScript)

These capabilities should be delivered via **richer `agentRules`** in `agent-orchestrator.yaml`, NOT by coding new TypeScript reaction handlers. The spawned agent (Claude Code) is flexible — it can run `/polish`, `/copilot`, resolve comments, rebase, etc. We just need to tell it what to do.

**Implemented:**

| Capability | Approach | Bead |
|---|---|---|
| Inline comment audit trail | `agentRules`: "After fixing code, append `## Resolved Comments` table to PR description via `gh pr edit`" | bd-ara.1 ✅ |

NOTE: This is a **worker self-certification audit trail**, not GitHub thread resolution. Merge-gate condition #5 still uses `scm.getPendingComments()` `isResolved`. Workers must still fix the underlying code.

**Not yet started:**

| Capability | Approach | Bead |
|---|---|---|
| Stale branch rebase | `agentRules`: "If mergeable=UNKNOWN or CONFLICTING, rebase on main" | bd-ara.2 |
| CHANGES_REQUESTED recovery | `agentRules`: "After addressing review comments, push and wait for re-review" | bd-ara.4 |
| Test failure self-healing | `agentRules`: "Read CI logs, fix failing tests, push fixes" | bd-ara.5 |
| PR polish loop | `agentRules`: "Use /polish to iteratively fix blockers until 6-green" | — |

**Design principle**: The lifecycle-worker spawns sessions and detects state transitions. The agent inside the session handles everything flexibly via its prompt and agentRules. We code infrastructure (spawn, kill, observe), not business logic.

## Verification Plan

1. **Merge PR #129** (backfillAllPRs)
2. **Restart lifecycle-worker** with new build
3. **Observe backfill logs**: `grep "lifecycle.backfill" ~/.openclaw/logs/ao-lifecycle-agent-orchestrator.err.log`
4. **Verify sessions spawn** for uncovered PRs
5. **Watch one PR** progress through reactions: `changes_requested → send-to-agent → worker fixes → approved → auto-merge`
6. **Confirm merge**: PR reaches 6-green, auto-merge fires, PR is merged

## Config Required

```yaml
# In ~/.openclaw/agent-orchestrator.yaml
projects:
  agent-orchestrator:
    backfillAllPRs: true  # Already set
    reactions:
      approved-and-green:
        auto: true
        action: auto-merge  # Already set
      changes-requested:
        auto: true
        action: send-to-agent  # Already set
      ci-failed:
        auto: true
        action: send-to-agent  # Default
```

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Thundering herd spawning | One PR per 5-min cycle |
| GraphQL exhaustion | listOpenPRs uses REST API |
| Zombie sessions | Exit proof + kill on merge (#99) |
| Dead session reactions | send-to-agent logged as failure, escalation after retries |
