# Autonomous Multi-CLI Orchestrator Design

**Date:** 2026-04-02  
**Status:** Draft for review  
**Scope:** `jleechanorg/agent-orchestrator-ts` fork (with upstream compatibility plan)

---

## Problem

The current `*-orchestrator` tmux sessions are interactive supervisor chats. They are useful when actively driven, but idle when no human/automation feeds prompts. Meanwhile, lifecycle workers keep deterministic automation running.

This creates a gap:

1. Base automation works without orchestrator chats.
2. Adaptive coordination (prioritization, routing, escalation) stalls without human input.
3. Multi-CLI usage is fragmented and lacks a first-class scheduling policy.

## Goals

1. Make orchestration autonomous without requiring an active chat operator.
2. Support policy-driven multi-CLI routing across agent plugins (`claude-code`, `codex`, `cursor`, `gemini`, `opencode`, etc.).
3. Keep existing lifecycle-worker behavior stable and backwards compatible.
4. Preserve strict safety boundaries (no accidental PR ownership by orchestrator, no unbounded spawn loops).
5. Make decisions auditable and reproducible.

## Non-Goals

1. Replacing lifecycle-worker with an LLM loop.
2. Removing interactive orchestrator sessions.
3. Changing existing worker task semantics by default.
4. Enabling blind auto-merge without existing gate checks.

---

## Current-State Findings (Code-Backed)

1. `ao start` starts lifecycle worker regardless of orchestrator session creation.
2. `ao spawn` also ensures lifecycle worker before spawning.
3. Orchestrator sessions are tagged (`role=orchestrator`) and intentionally blocked from claiming PRs.
4. Lifecycle manager is the deterministic backbone for status polling and reactions.
5. Fork-only `backfillAllPRs` already adds autonomous uncovered-PR spawn/claim in lifecycle loop.

Implication: the right architecture is to add autonomous decisioning as a separate daemon/control plane, not overload interactive tmux chats.

### Ownership boundaries (must be single-writer)

To prevent dual-control races, each responsibility has one owner:

| Responsibility | Owner | Notes |
|---|---|---|
| Session status polling/state transitions | `lifecycle-worker` | Existing behavior remains authoritative. |
| Reaction execution (`ci-failed`, `changes-requested`, etc.) | `lifecycle-worker` | Existing deterministic reaction path stays primary. |
| `backfillAllPRs` uncovered-PR detection + spawn/claim | `lifecycle-worker` (phase 0-2) | Daemon observes only; no duplicate spawn/claim. |
| Cross-session prioritization and escalation planning | `orchestrator-daemon` | Produces intents, not direct PR ownership. |
| Worker instruction routing (`send_instruction`) | `orchestrator-daemon` | Via existing session-manager send path. |
| Merge attempt trigger | `orchestrator-daemon` (phase 3+) | Only through existing merge gate checks. |
| PR ownership | worker sessions only | Orchestrator role never owns PR metadata. |

---

## Proposed Architecture

### 1) New Core Service: `orchestrator-daemon`

Add a detached per-project process (parallel to `lifecycle-worker`) that runs a bounded control loop:

`Sense -> Plan -> Decide -> Act -> Verify -> Record`

Responsibilities:

1. Aggregate project state from session manager + lifecycle outputs + SCM/tracker summaries.
2. Generate actionable intents from policy/rules.
3. Select CLI/runtime for each action via multi-CLI scheduler.
4. Execute actions through existing session-manager APIs.
5. Record evidence and enforce limits/circuit breakers.

### 1.1) Daemon lifecycle and lock model

The daemon must use the same operational model as lifecycle-worker:

1. Per-project startup lock and PID file (single active daemon per project).
2. Duplicate-instance detection via lock + process table verification.
3. Graceful shutdown with heartbeat termination and PID cleanup.
4. CLI-managed lifecycle:
   - `ao start` ensures daemon (when enabled)
   - `ao stop` stops daemon
   - `ao status` surfaces daemon health
   - `ao doctor` validates lock/PID/log consistency
5. Process supervision through launchd/systemd-compatible restart policy.

### 2) Keep tmux orchestrator as optional operator UX

Interactive `*-orchestrator` sessions remain attachable for manual supervision/debug. They are no longer required for autonomous operation.

### 3) Event-driven autonomy queue

Introduce an internal queue keyed by dedupe IDs:

`<project>:<resource>:<signal>:<sha-or-ts>`

Signals include:

1. CI fail transitions.
2. changes_requested transitions.
3. stale/no-activity windows.
4. uncovered PR detection.
5. merge gate ready transitions.
6. manual escalation requests.

Queue rules:

1. Coalesce repeated events in cooldown windows.
2. Keep last-write-wins payload for the same dedupe key.
3. Bound queue size per project.
4. Use explicit retry counters and retry budgets per event class.
5. Move repeatedly failing events to a dead-letter queue (DLQ) for operator inspection.
6. Persist queue + state transitions so daemon restarts can replay safely.

### 3.1) Persistence and replay model

Add a persistent state store for orchestrator decisions and action outcomes:

1. `events` (immutable event log, with dedupe key and enqueue metadata).
2. `actions` (planned/executed actions, selection decisions, and verification results).
3. `idempotency` (action hash -> last known outcome) to avoid duplicate side effects.

Replay behavior:

1. On daemon boot, replay unverified actions and pending events in deterministic order.
2. Re-run only idempotent-safe actions; otherwise escalate as `request_human`.
3. Preserve full audit lineage (`event -> decision -> action -> verification`).

### 3.2) Transaction boundaries and delivery semantics

Delivery model:

1. Queue delivery is at-least-once.
2. Action side effects are made idempotent via action hash + outcome store.
3. Success is recorded only after post-condition verification passes.

Crash window handling:

1. Crash before `act`: event remains pending and is retried.
2. Crash after `act` before verification: daemon replays with idempotency check first.
3. Crash after verification before commit: verification is rerun and commit is retried.

### 4) Rule-first + LLM-second decisioning

Decision pipeline:

1. Deterministic rules for known scenarios (preferred).
2. LLM planner only for ambiguous cases.
3. Planner output constrained to typed action schema.
4. Policy validator can reject/modify any planner output.

Action schema (v1):

1. `spawn_worker`
2. `send_instruction`
3. `claim_pr`
4. `kill_session`
5. `request_human`
6. `attempt_merge` (behind existing merge gates)
7. `pause_project`
8. `resume_project`

Execution identity constraints:

1. `claim_pr` may only target worker sessions and never marks orchestrator as PR owner.
2. `attempt_merge` runs under existing SCM merge gate path and cannot bypass required checks.
3. Planner outputs are advisory until validated by policy + schema + role checks.

### 5) Multi-CLI scheduler

Add policy-controlled routing layer:

1. Capability matrix by `agent plugin x runtime plugin x task class`.
2. Priority lanes (`cheap-fast`, `balanced`, `high-reliability`).
3. Fallback chain on rate-limit/timeout/tooling failures.
4. Retry budget by action type and project.

Example routing policy:

1. Triage and summarization -> fast/cheap CLI.
2. CI fix loops -> balanced CLI.
3. Merge-critical or high-risk refactors -> high-reliability CLI.

Capability discovery contract:

1. Scheduler reads capabilities from plugin manifests + runtime probes.
2. Every selection requires `supports(taskClass)` and `isAvailable()` checks.
3. If no capable CLI is available, action degrades to `request_human` (no blind fallback).
4. Selection results include explicit reason codes for audit/debug (`unsupported`, `unavailable`, `budget_blocked`).

### 6) Safety and resilience

1. Hard invariants:
   - orchestrator role cannot claim PR ownership.
   - branch protections and merge gates remain mandatory.
2. Action budgets:
   - max actions/cycle, max actions/hour, max concurrent spawned workers.
3. Circuit breakers:
   - repeated claim failures.
   - repeated spawn failures.
   - repeated unchanged CI failures for same SHA.
4. Auto-pause with explicit reason and resume policy.
5. Require randomized exponential backoff and retry budgets to prevent retry storms.
6. Enforce command allowlists by role and action type.
7. Require post-condition verification before action success is recorded.
8. Add compensating/rollback actions for multi-step mutating flows where possible.

### 7) Observability and audit

Emit structured records:

1. `orchestrator.cycle`
2. `orchestrator.decision`
3. `orchestrator.action`
4. `orchestrator.verification`
5. `orchestrator.circuit_breaker`

Each action log should include:

1. triggering signals
2. selected policy rule
3. chosen CLI/runtime
4. expected result
5. observed result
6. latency/cost summary

Add real-time telemetry:

1. queue depth, event lag, and DLQ count
2. action success/failure rate by action type
3. planner usage ratio (rule-hit vs planner-assisted)
4. budget utilization by project and by CLI/agent
5. circuit-breaker open/half-open/closed state transitions
6. worker health heartbeat and stale worker count

Add traceability:

1. assign a correlation/trace ID to each event and propagate through all actions
2. ensure trace IDs appear in logs, metrics labels, and escalation notifications

### 8) Operability controls

1. Expose daemon health endpoint and status snapshot (`/healthz`, `/state`).
2. Support dynamic config reload without restart (policy/scheduler/safety knobs).
3. Add operator commands:
   - pause/resume queue processing
   - inspect/replay/drop DLQ items
   - force-disable planner-assisted mode
4. Supervise daemon process via launchd/systemd semantics with restart policy.
5. Add emergency kill switches:
   - global `defaults.orchestratorAutonomy.enabled=false`
   - per-project disable override
   - runtime planner disable (`mode=rule-first`)

---

## Configuration Additions (Proposed)

```yaml
defaults:
  orchestratorAutonomy:
    enabled: false
    intervalMs: 60000
    mode: rule-first   # rule-first | planner-assisted
    maxActionsPerCycle: 5
    maxConcurrentActions: 3
    actionBudgetPerHour: 120

projects:
  agent-orchestrator:
    orchestratorAutonomy:
      enabled: true
      queue:
        maxSize: 500
        dedupeWindowMs: 300000
        maxRetriesPerEvent: 4
        dlqEnabled: true
        dlqMaxSize: 1000
      persistence:
        backend: sqlite
        replayOnBoot: true
      scheduler:
        lanes:
          cheap-fast: [cursor, opencode]
          balanced: [codex, claude-code]
          high-reliability: [claude-code, codex]
        fallback:
          onRateLimit: [codex, cursor]
          onTimeout: [claude-code, codex]
      safety:
        maxSpawnPerHour: 30
        maxClaimFailuresPerPRPerHour: 3
        pauseOnRepeatedFailures: true
      escalations:
        notifyAfterMinutes: 30
        requireHumanForMergeOverride: true
      operability:
        healthPort: 3910
        allowConfigReload: true
        allowDlqReplay: true
```

Notes:

1. Defaults keep behavior unchanged (`enabled: false`).
2. Project-level overrides allow gradual rollout.
3. Precedence: project setting overrides defaults; missing keys inherit from defaults.
4. Coexistence with existing knobs:
   - `reactions`, `pollers`, `taskQueue`, `autoMerge`, `mergeGate` remain canonical.
   - `orchestratorAutonomy` is additive and cannot override merge-gate invariants.
5. Migration: phase 0 starts daemon in observer-only mode with no mutating actions.

---

## Core Interfaces (Proposed)

### `OrchestratorDaemon`

```ts
interface OrchestratorDaemon {
  start(projectId: string): Promise<void>;
  stop(projectId: string): Promise<void>;
  enqueue(projectId: string, signal: OrchestratorSignal): Promise<void>;
  replayPending(projectId: string): Promise<void>;
  getState(projectId: string): Promise<OrchestratorState>;
}
```

### `OrchestratorPolicyEngine`

```ts
interface OrchestratorPolicyEngine {
  plan(input: PolicyInput): Promise<PlannedAction[]>;
  validate(actions: PlannedAction[], input: PolicyInput): PlannedAction[];
}
```

### `MultiCliScheduler`

```ts
interface MultiCliScheduler {
  select(action: PlannedAction, context: SelectionContext): Selection;
  recordOutcome(selection: Selection, outcome: SelectionOutcome): void;
}
```

### `ActionValidator`

```ts
interface ActionValidator {
  validate(action: PlannedAction, context: ValidationContext): ValidationResult;
  verifyPostCondition(action: ExecutedAction, context: VerificationContext): Promise<VerificationResult>;
}
```

---

## Implementation Plan

### Phase 0: Instrumentation + shadow mode

1. Add daemon process skeleton and queue.
2. Compute decisions but do not execute mutating actions.
3. Log hypothetical actions and compare against real outcomes.
4. Add DLQ wiring, trace IDs, and health/readiness endpoints.
5. Wire `ao start/stop/status/doctor` daemon lifecycle visibility.
6. Explicitly disable daemon mutation of `backfillAllPRs` paths in this phase.

### Phase 1: Safe autonomous actions

1. Enable `send_instruction`, `request_human`, non-mutating sync actions.
2. Verify dedupe/cooldowns and action-budget enforcement.
3. Validate config reload and operator control commands.

### Phase 2: Controlled worker management

1. Enable `spawn_worker`, `kill_session`, `claim_pr` under limits.
2. Integrate with fork’s `backfillAllPRs` to avoid duplicate responsibilities.
3. Enable persisted replay for daemon restarts and crash recovery tests.
4. Keep `backfillAllPRs` ownership in lifecycle-worker; daemon only consumes surfaced signals.

### Phase 3: Merge-path actions

1. Enable `attempt_merge` only when existing merge-gate returns green.
2. Keep explicit policy knob for human-required merge override.

### Phase 4: Upstream compatibility strategy

1. Keep daemon optional and isolated from upstream-critical paths.
2. Gate fork-only behavior under feature flags.
3. Propose minimal upstreamable primitives after stabilization.
4. Start with single durable backend (`sqlite`) and defer backend abstraction.

---

## Integration with Existing Components

1. `lifecycle-worker` remains source of deterministic session state transitions.
2. `orchestrator-daemon` consumes lifecycle outputs and drives higher-level actions.
3. Existing session-manager invariants remain authoritative.
4. Existing notifier pipeline is reused for escalation/human paging.

Event source contract:

1. Daemon consumes lifecycle observer outputs (not independent duplicate polling loops).
2. Session-manager remains write authority for session metadata and runtime actions.
3. Daemon writes intents/actions/evidence records; lifecycle manager writes status transitions.

---

## Success Metrics

1. Median time from CI failure to corrective action.
2. Median time from changes_requested to fix commit.
3. Percentage of PRs that progress without human nudges.
4. Duplicate/contradictory action rate (must trend toward zero).
5. CLI routing success rate and fallback effectiveness.
6. Autonomous action rollback/incidents per week.
7. DLQ ingress rate and average time-to-resolution.
8. Planner token budget burn-rate and planner-fallback frequency.

---

## Risks and Mitigations

1. Duplicate control loops (`lifecycle-worker` vs daemon).
   - Mitigation: explicit responsibility split and idempotent action keys.
2. Action thrash on noisy signals.
   - Mitigation: dedupe windows, coalescing, per-PR cooldowns.
3. Misrouting to weak CLI for high-risk changes.
   - Mitigation: policy tiers + hard constraints by task class.
4. Hidden failure loops consuming quota.
   - Mitigation: action budgets, circuit breakers, pause-on-failure.
5. Retry amplification/cascading failures during upstream outages.
   - Mitigation: exponential backoff + jitter, strict retry budgets, fail-fast modes.
6. Silent success (action marked done but state unchanged).
   - Mitigation: required post-condition verification and trace-linked evidence.
7. Control-plane duplication between lifecycle-worker and daemon.
   - Mitigation: ownership table + per-responsibility single-writer rule + startup locks.

---

## Open Questions

1. Should planner-assisted mode be project-default or opt-in only?
2. Should merge attempts remain daemon-driven or lifecycle reaction-driven?
3. How should we expose autonomy controls in dashboard UX?
4. Should `backfillAllPRs` move fully under daemon ownership in v2?
5. What is the minimal upstream-compatible subset to propose first?

---

## Failure Modes and Recovery

1. Queue backlog growth:
   - Detect: queue lag + DLQ ingress metrics.
   - Recover: throttle new enqueue, scale workers, temporarily disable planner-assisted mode.
2. Repeated claim failures on same PR:
   - Detect: per-PR failure counter threshold.
   - Recover: open circuit for that PR and escalate to human.
3. Scheduler fallback exhaustion:
   - Detect: no eligible CLI candidates.
   - Recover: deterministic `request_human` with reason codes and context bundle.
4. Daemon appears healthy but no forward progress:
   - Detect: heartbeat alive with stagnant processed-event counter.
   - Recover: restart daemon, replay pending events, emit incident marker.
5. Crash during mutate/verify boundary:
   - Detect: action record in `executing` without terminal verification.
   - Recover: replay via idempotency check and mandatory post-condition verification.

---

## Test Plan (minimum acceptance)

1. Daemon startup/shutdown idempotence with lock contention.
2. Crash-replay correctness across `act`/`verify` boundaries.
3. No duplicate `claim_pr` when `backfillAllPRs` is enabled.
4. Merge-gate preservation for all `attempt_merge` paths.
5. Capability discovery and degraded-mode behavior when selected CLI is unavailable.
6. Kill-switch behavior:
   - global autonomy disable
   - project-level autonomy disable
   - planner-assisted mode forced off
7. Observability completeness:
   - trace ID propagation
   - required audit fields for all autonomous actions.

---

## Proposed File-Level Work Breakdown (future PRs)

1. `packages/cli/src/commands/orchestrator-daemon.ts` (new)
2. `packages/cli/src/lib/orchestrator-daemon-service.ts` (new)
3. `packages/core/src/orchestrator-daemon.ts` (new)
4. `packages/core/src/orchestrator-policy-engine.ts` (new)
5. `packages/core/src/multi-cli-scheduler.ts` (new)
6. `packages/core/src/orchestrator-queue.ts` (new)
7. `packages/core/src/types.ts` (config + types additions)
8. `packages/web` dashboard surfaces for autonomy state (incremental)
