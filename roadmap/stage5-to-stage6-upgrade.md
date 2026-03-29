# Stage 5 → Stage 6 Upgrade Plan

**Date**: 2026-03-29
**Classification**: Stage 5 (advanced, unstable) → Stage 6 (autonomous, self-sustaining)
**Rating**: 9.2/10 sophistication — the gap is reliability, not capability

## Core Thesis

> The system can execute and improve itself, but cannot yet reliably run end-to-end without active human supervision and repair.

Stage 6 = **the system becomes the glue**, not the human.

---

## What's Working (Stage 5 Evidence)

| Capability | Evidence |
|---|---|
| Multi-surface control plane | cmux/tmux + Claude/Codex CLI + AO + Slack + MCP mail |
| Intent-level orchestration | "run loop, nudge PR until 7-green", "audit → beads → dispatch" |
| Agent fleet management | jc-971→jc-979 sessions, reaper, lifecycle-worker, session DB |
| System introspection | "ack without execution" failure mode ID, SOUL.md policy fix, skeptic audits |
| Parallel execution at scale | 9 concurrent AO sessions with scoped work |
| Self-improving components | beads tracker, skeptic agent, harness engineering, /evolve_loop |

---

## 5 Blockers to Stage 6

### Blocker A: Execution Reliability — "Ack Without Execution"

**Problem**: Agents acknowledge tasks ("On it") but don't complete them. Repeated follow-ups required. This is the #1 Stage 6 blocker.

**Root cause**: No execution-completeness enforcement. An agent can ack and then context-drift, get reaped, or silently fail without producing artifacts.

**Fix**: Every dispatched task must produce a **verifiable artifact** (PR URL, bead update, worker ID, or explicit failure report) within a bounded time window. No artifact = escalation.

| Action | Bead | Priority | Status |
|---|---|---|---|
| Task completion attestation: agent must post artifact URL or failure reason before session ends | bd-s6a1 (new) | P0 | open |
| Timeout-based escalation: tasks without artifacts after N minutes auto-escalate to Slack | bd-s6a2 (new) | P1 | open |
| Send-to-agent SHA dedup (prevents re-sending same work) | bd-n039 | P0 | open |
| Reaction send dedup (prevents 5-9x duplicate context burn) | feedback_reaction_send_dedup | — | known |
| **CHRONIC: zombie worker cleanup** — 5+ fix PRs merged, zombies persist every session | bd-s6z1 (new) | P0 | open |

### Blocker B: Control Plane Fragmentation — No Unified State Model

**Problem**: State is scattered across cmux terminals, AO session DB, Slack, MCP mail, lifecycle-worker logs, and cron jobs. No single source of truth. Sessions die without Slack reflecting it. MCP mail doesn't fan out.

**Root cause**: Each subsystem was built independently. No reconciliation layer.

**Fix**: Single state reconciliation loop that syncs AO session DB ↔ tmux liveness ↔ Slack status ↔ PR state.

| Action | Bead | Priority | Status |
|---|---|---|---|
| State reconciliation daemon: periodic sync of session DB + tmux + Slack + PR state | bd-s6b1 (new) | P0 | open |
| OpenClaw gateway auto-restart (launchd plist) | bd-z14m | P1 | open |
| Unified AO launchd manager | bd-azp1 | P1 | open |
| Doctor.sh port mismatch | bd-yk9h | P2 | open |
| OpenClaw canary gateway-independent | bd-y8sb | P2 | open |

### Blocker C: Agent-to-Agent Communication Broken

**Problem**: MCP mail not fanning out. Workers not visible in Slack. No inter-agent coordination protocol. Agents can't discover each other's work.

**Root cause**: MCP mail is configured but non-functional for fanout. Slack posting uses bot token (self-loop prevention blocks it). No shared work registry beyond session DB.

**Fix**: Working agent communication layer — either fix MCP mail fanout or implement a simpler shared-state broadcast.

| Action | Bead | Priority | Status |
|---|---|---|---|
| Fix MCP mail fanout or replace with working broadcast mechanism | bd-s6c1 (new) | P1 | open |
| OpenClaw memory corpus (mem0 empty) | bd-woy8 | P2 | open |
| Agent identity disclosure in Slack | CLAUDE.md rule | — | implemented |

### Blocker D: Governance Exists but Not Enforced

**Problem**: 7-green gates, skeptic, beads all exist — but SKIPPED→PASS bug, author mismatches, merge-gate bypasses, and cron misalignment mean governance is advisory, not enforcing.

**Root cause**: Each governance component was built and tested in isolation. Cross-layer integration (CLI output format ↔ GHA jq filter ↔ lifecycle-worker trigger) breaks silently.

**Fix**: Fix the specific broken gates, then add integration tests that verify the full governance chain.

| Action | Bead | Priority | Status |
|---|---|---|---|
| Skeptic Gate false-positive: PASS on missing CR APPROVED | bd-kvvx | P0 | open |
| merge-gate: skepticRequired still passes on VERDICT=SKIPPED | bd-866a | P0 | open |
| 7 PRs merged without CR APPROVED | bd-vpzh | P0 | open |
| Main branch zero branch protection | bd-io8q | P0 | open |
| Merge executor doesn't block on CI failures | bd-jp7q | P1 | open |
| Verify 6-green in code before auto-merge fires | bd-mjtn | P1 | open |
| SKEPTIC_BOT_AUTHOR defaults diverge | bd-xgmd | P1 | open |
| Skeptic Gate infra broken (VERDICT: SKIPPED on all PRs) | bd-1lni | P0 | open |

### Blocker E: Human Still Active Orchestrator

**Problem**: Jeffrey manually triggers flows, intervenes frequently, debugs execution, coordinates systems directly. The system requires a human operator to function.

**Root cause**: Blockers A-D compound. Without reliable execution (A), unified state (B), agent communication (C), or trustworthy governance (D), a human must fill every gap.

**Fix**: This blocker resolves itself when A-D are fixed. The specific remaining gap is: the system doesn't originate its own agenda consistently.

| Action | Bead | Priority | Status |
|---|---|---|---|
| System-originated agenda: evolve_loop runs autonomously, identifies and dispatches work | bd-y5v.1 | P0 | in_progress |
| Lifecycle-worker crash recovery (launchd thrashing) | feedback_lw_launchd_thrashing | — | known |
| ao start branch invariant violation | bd-8gld | P1 | open |

---

## Execution Order (Critical Path)

```
Phase 1: Governance enforcement (Week 1)
  Fix bd-io8q (branch protection) → bd-kvvx + bd-866a + bd-vpzh (merge-gate enforcement)
  → bd-1lni + bd-xgmd (skeptic infra) → bd-mjtn (code-level 6-green check before merge)

Phase 2: Execution completeness (Week 2)
  bd-s6a1 (task completion attestation) → bd-s6a2 (timeout escalation)
  → bd-n039 (send-to-agent dedup)

Phase 3: Unified state (Week 3)
  bd-azp1 (unified launchd) → bd-z14m (gateway auto-restart)
  → bd-s6b1 (state reconciliation daemon)

Phase 4: Agent communication (Week 4)
  bd-s6c1 (fix MCP mail or replace) → bd-woy8 (mem0 population)

Phase 5: Validation (Week 5)
  Run 48h hands-off test. Measure:
  - Zero-touch merge rate (target: >50%)
  - Ack-without-execution rate (target: 0%)
  - State consistency (Slack reflects ground truth)
  - Agent-originated work items (target: >30% of dispatched tasks)
```

---

## Success Criteria for Stage 6

All must hold for 48 continuous hours:

1. **Zero ack-without-execution**: every task produces artifacts or explicit failure
2. **Slack reflects ground truth**: no phantom sessions, no invisible workers
3. **Governance is enforced**: zero non-green merges, skeptic PASS required
4. **System originates agenda**: evolve_loop or lifecycle-worker dispatches work without human trigger
5. **Human interaction is policy-only**: Jeffrey sets goals and reviews outcomes, doesn't debug execution

---

## Key Metric

> **Zero-touch 6-green rate**: 16% baseline (2026-03-24) → 23% after Phase 1 fixes → target 50%+ for Stage 6

Tracked in bd-x1s (epic).

---

## Related Documents

- `roadmap/zero-touch-6green-rate.md` — rate improvement tracking
- `roadmap/ao-self-healing-architecture.md` — self-healing component audit
- `roadmap/harness-engineering-v2.md` — harness improvement plan
- `roadmap/skeptic-ao-worker-architecture.md` — skeptic architecture (settled)
