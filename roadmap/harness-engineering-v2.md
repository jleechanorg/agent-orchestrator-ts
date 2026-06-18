# Harness Engineering v2 — Ryan Talk Insights

**Date**: 2026-03-26
**Source**: OpenAI Ryan talk on Codex harness engineering patterns
**Epic**: Zero-touch rate 70% → 95%

## Context

Ryan's team at OpenAI runs Codex agents in a tmux+local-app pattern strikingly similar to AO. Key insight: **"multiple shots on goal"** — enforce guardrails at coding time (agentRules), test time (wholesome tests), AND review time (dedicated review agents). Single-point enforcement fails ~28% of the time (our [agento] prefix gap proves this).

## Initiatives

### 1. PR Media Proof (bd-mpr) — DONE

Agents must attach visual proof to every PR. Ryan's exact quote: "I'm expecting that they did the job and that they can prove to me that the code is worth merging."

- **What**: Screenshots/video attached to PR body showing the change works
- **How**: agentRules + /pr-media skill + wholesome CI check
- **Impact**: Faster review cycles, better evidence for /er gate, catches UI regressions
- **Implementation**:
  - `~/.openclaw/agent-orchestrator.yaml`: `defaults.agentRules` updated with PR media proof instruction
  - `~/.claude/commands/pr-media.md`: `/pr-media` skill for capture-and-attach workflow
  - `.github/workflows/wholesome.yml`: CI checks for Evidence section presence + media attachment

### 2. Wholesome Tests (bd-wht) — P1

Stripe-originated pattern: tests on code STRUCTURE, not just behavior. Ryan: "You can scan the repo to see if codex is abusing disabling my eslint."

- **What**: CI checks that assert structural invariants on the diff
- **How**: GitHub Action + wholesome.test.ts with structural assertions
- **First check**: [agento] prefix on PR titles (supplements bd-pfx runtime hooks)
- **Future checks**: no @ts-ignore, no eslint-disable, fork isolation compliance, evidence sections
- **Impact**: "Multiple shots on goal" for every quality dimension

### 3. Architecture Map (bd-arc) — P2

Ryan: "Architecture.md gives a high-level lay of the land so agents can efficiently page in context." Reference: Matt Rickard's blog post on codebase maps.

- **What**: docs/architecture.md with package graph, plugin system guide, "if X then also Y"
- **How**: Progressive disclosure index — agents.md/CLAUDE.md points to deeper docs per persona
- **Impact**: Reduces context waste from agents exploring wrong packages

### 4. Review-Fix Respawn (bd-rfr) — P1

When CR posts CHANGES_REQUESTED and the worker is dead, spawn a fresh worker with pre-loaded review context. Currently 2 of 4 open PRs are stuck with no worker.

- **What**: Escalation action that spawns fresh worker when send-to-agent fails on CHANGES_REQUESTED PR
- **How**: New action type in reactions schema, lifecycle-manager integration
- **Impact**: ~10-15pp toward 95% zero-touch rate

## Principles from Ryan Talk

1. **Principles over procedures** in agent docs — "encode semantic meaning" not micro-instructions
2. **Code is free** — build bespoke throwaway tools for agents (observability, capture, validation)
3. **100% code coverage** is achievable because agents are patient and have no feelings
4. **Progressive disclosure** — index doc points to persona-specific deeper docs, agent discovers what's relevant
5. **"Why hasn't the agent done this already?"** — the right question for systems thinking

## Priority Order

1. **bd-pfx** (in progress, ao-1025) — prefix enforcement hooks
2. **bd-rfr** — review-fix respawn (unblocks 2 stuck PRs immediately)
3. **bd-wht** — wholesome tests (supplements bd-pfx with CI-time enforcement)
4. ~~**bd-mpr**~~ — PR media proof → DONE (agentRules + /pr-media skill + wholesome.yml CI)
5. **bd-arc** — architecture map (reduces context waste)

## Success Criteria

- Zero-touch rate: 70% → 85% (after bd-pfx + bd-rfr)
- Zero-touch rate: 85% → 95% (after bd-wht + bd-mpr reduce review friction)
- Agent context efficiency: measurable reduction in "exploring wrong package" patterns (after bd-arc)

## 2026-06-18 Update — babysit-not-a-driver systemic gap (bd-snx3)

A 5-whys investigation of [worldarchitect.ai #7618](https://github.com/jleechanorg/worldarchitect.ai/pull/7618) (rate-limit centralization) revealed a systemic harness gap that pre-dates and out-scopes the original 4 initiatives. The pattern recurred in **6+ PRs over the last 2 weeks**: PRs #7618, #7276, #7558, #7586, BQ wiring, #7420, wa-2246.

### Symptom

Babysit cron posts "Blocked: Green Gate failing" status updates and sends generic "keep working" nudges to workers. The same CI failure persists for 15+ ticks (4+ hours) with zero progress. Workers go idle between pushes; PRs reach stale-by-CI states with human intervention required.

### Root cause (5-whys)

| # | Why | Answer |
|---|-----|--------|
| 1 | Why is the PR not making progress? | Same CI gate failing, no fixes landing |
| 2 | Why is no fix landing? | Worker is doing one partial fix per push, then waiting for CI |
| 3 | Why one fix per push? | Worker reads the first remaining failure, fixes that, then waits |
| 4 | Why wait? | Worker treats "CI pending" as idle state, not parallel-fix time |
| 5 | Why is babysit not breaking the loop? | Babysit's success metric is "status posted," not "failure fixed" — generic nudges do not extract failure text into actionable instructions |

**Conclusion:** the failure class is *silent degradation + missing validation*. Babysit was designed to observe and report, not to drive. Generic "keep going" messages are the wrong shape — workers that have already tried and failed need exact file:line + specific patch.

### Fix landed (this PR)

| Layer | File | Change |
|---|---|---|
| Global rule | `~/.claude/CLAUDE.md` | New section "PR driver loop contract — fix-all before push" — after every push, enumerate ALL gate failures and fix ALL in one local pass |
| Skill (shipped) | `skills/babysit/SKILL.md` (+ `bin/`, `tests/`) | New "DRIVER mode" section — when same CI failure appears ≥2 ticks, extract file:line + change and send `ao send <session> "<exact fix>"` |
| Skill (shipped) | `skills/pr-driver-protocol/SKILL.md` | New 5-step loop: ENUMERATE → CLASSIFY → FIX-ALL → VERIFY → PUSH |

**Shipment:** both skills live in this repo's `skills/` directory, so `bash scripts/setup.sh` (which calls `scripts/install-repo-skills.sh`) symlinks them into `~/.claude/skills/` on a fresh checkout. The same files are also kept in the author's user-scope `~/.claude/skills/` for active-session use. The global `~/.claude/CLAUDE.md` rule is **not** in source control (it is per-user configuration); the doc update in this repo is the durable surface pointing at it.

### Why this is "harness" not "core code"

The fix lives in **user-scope harness files** (`~/.claude/CLAUDE.md`, `~/.claude/skills/`) plus **two new skills shipped in `skills/`** plus one **doc update** in this repo. No `packages/core/`, `packages/cli/`, or `packages/plugins/` code is changed. This is the lowest-risk harness layer — a `bash scripts/setup.sh` user or a new agent context will pick it up via the existing user-scope symlinks (`scripts/install-repo-skills.sh` symlinks any `skills/*/` in this repo into `~/.claude/skills/` and `~/.codex/skills/`).

### Evidence

- Investigation: 2026-06-18 /harness 5-whys, see `~/roadmap/nextsteps-2026-06-18-babysit-driver-harness.md`
- Memory pointers: [[pr-driver-loop-contract]] (worker-side), [[babysit-not-a-driver]] (observer-side)
- Bead: `bd-snx3`
- Pattern recurrence: PRs #7618, #7276, #7558, #7586, BQ wiring, #7420, wa-2246 (6+ PRs in 2 weeks)
