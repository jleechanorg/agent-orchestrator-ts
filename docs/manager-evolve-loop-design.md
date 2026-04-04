# Manager AO Evolve Loop Architecture

**Date:** 2026-04-04
**Status:** Design Draft
**Owner:** AO system
**Scope:** `jleechanorg/agent-orchestrator` fork

---

## Problem Statement

The existing `/eloop` skill runs as an **external** 12-hour autonomous loop — a separate AO session that observes the ecosystem, measures zero-touch rate, diagnoses friction, and dispatches fixes. It works, but it has three structural limitations:

1. **Latency**: It's triggered on a schedule (every 10 min via `/loop`), not reactively. A PR that stalls at 09:01 waits until 09:10 for the next cycle.
2. **Blind spots**: The external loop only sees what the lifecycle-manager surfaces as events. Internal reaction failures, dedup silently swallowing sends, and tmux session stalls are invisible to it.
3. **Isolation**: Each manager agent (lifecycle-manager, skeptic-cron, task-queue) has its own polling loop but no self-diagnosis. A stuck `pollAll()` loop cannot observe itself.

Manager agents (the lifecycle-manager process and any AO worker that manages other workers) should run **internal evolve loops** — lightweight self-assessment phases embedded in their existing poll cycles, with escalation paths back to the external loop for cross-cutting issues.

---

## Design Principles

| Principle | Implication |
|---|---|
| **Embed, don't replace** | Internal evolve phases fit inside existing `pollAll()` ticks — no new timers, no separate processes |
| **Self-assess only, escalate for action** | Manager agents measure and record; they dispatch workers or modify config only for their narrow domain |
| **Cross-cutting = external loop** | Beads, PR conflicts, zero-touch regressions, and multi-session coordination route to the external loop |
| **Fail-closed** | Evolve-phase errors are logged and skipped; they must not crash the poll cycle |
| **Hard bounds on autonomous action** | Self-fix is limited to config toggles and reaction retries; code changes always go to a dispatched worker |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  External Evolve Loop (/eloop via /loop 10m)            │
│  - Full 7-phase cycle every 10 min                     │
│  - Cross-repo coordination                             │
│  - Creates/updates beads for cross-cutting issues       │
│  - Dispatches workers for code changes                │
└──────────────────────┬──────────────────────────────────┘
                       │ escalation events
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Lifecycle Manager (lifecycle-manager.ts)               │
│  Internal Evolve Phases (embedded in pollAll):         │
│  - OBSERVE: session health snapshot                    │
│  - MEASURE: PR-state transition rates                  │
│  - DIAGNOSE: reaction failures, dedup swallows, stalls │
│  - RECORD:  observability log entries                  │
│  - ESCALATE: cross-cutting → external loop or bead    │
└──────────────────────┬──────────────────────────────────┘
                       │ escalated events
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Other Manager Agents (task-queue, skeptic-cron)       │
│  - Same pattern: OBSERVE → MEASURE → DIAGNOSE → RECORD │
│  - Domain-specific metrics per manager                 │
└─────────────────────────────────────────────────────────┘
```

---

## Manager Agent Architecture

### Agent Types

There are two classes of manager agent:

**Class A — Lifecycle Manager (always-on daemon)**
The `lifecycle-worker` process. Runs `pollAll()` continuously. Owns all session state transitions and reaction execution.

**Class B — Dispatch Manager (AO worker with evolve capability)**
A standard AO worker that happens to own cross-cutting responsibilities (e.g., `skeptics-watcher`, `backlog-prioritizer`). These run evolve phases at the top of their work cycle and at session completion.

### What each manager agent manages

| Manager | Manages | Key Internal State |
|---|---|---|
| `lifecycle-manager` | All AO worker sessions, PR state, reactions | `states Map<SessionId, SessionStatus>`, `reactionTrackers Map<string, ReactionTracker>` |
| `skeptics-watcher` (worker) | Skeptic VERDICT quality, Gate pass/fail rates | Bead state, PR evidence quality |
| `backlog-prioritizer` (worker) | Open bead queue, PR coverage | Bead priorities, coverage gaps |
| `tmux-sweeper` (lifecycle-manager) | Zombie tmux sessions | `lastSweepTime`, orphan sessions |

### Evolve Loop Integration Point

Each manager agent runs evolve phases:
- **At the top of each poll/work cycle** — freshest possible observation
- **At a bounded frequency** — every N cycles, not every tick (prevents overhead)
- **On state-change events** — triggered reactively when a threshold is crossed

Frequency bounds:
- `lifecycle-manager`: every 5 `pollAll()` cycles (~5 min at default interval)
- `skeptics-watcher`: every invocation (lightweight — reads PR comments)
- `backlog-prioritizer`: every work cycle (~10 min via `/loop`)

---

## Per-Agent Evolve Loop Phases

### Phase 1: OBSERVE

What each manager observes about itself and its domain.

**lifecycle-manager:**
```
- Active sessions: count, status distribution (spawning/working/stuck/merged)
- Dead sessions: recently terminated, cause of death
- Tmux orphans: sessions in tmux but not in AO DB
- Reaction execution: last N reaction results (success/fail/escalate)
- Dedup suppression rate: reactions that fired but were dedup-silenced
- Poll cycle duration: is pollAll() slowing down?
- MCP mail inbox: unread messages, pending escalations
```

**skeptics-watcher:**
```
- Skeptic VERDICT distribution: PASS/FAIL/SKIPPED per PR
- Evidence Gate pass rate: are PRs failing format check?
- Skeptic false-positive rate: VERDICT=PASS but 7-green not met?
- Evidence bundle quality: terminal media, repro gist, test logs present?
```

**backlog-prioritizer:**
```
- Open beads: count by priority, age distribution
- PR coverage: open PRs with no active worker
- Stale beads: in_progress with no active session for >2h
- Zero-touch rate: rolling 24h, per-repo breakdown
```

**tmux-sweeper:**
```
- Orphan tmux sessions: count, age
- Sweep errors: sessions that failed to kill
- Session prefix coverage: are all project prefixes covered?
```

**Implementation:** Each manager emits a structured observation snapshot to its local observability store (`observer.recordOperation`) with metric name `manager_evolve.{agent}.observe`. The external loop reads these snapshots to build cross-manager views.

---

### Phase 2: MEASURE

Translate observations into rates and deltas.

**lifecycle-manager:**
```
reaction_success_rate  = reactions_succeeded / reactions_attempted (last 60 min)
dedup_suppress_rate   = deduped_reactions / total_reactions (last 60 min)
poll_cycle_duration_ms = median(pollAll() duration, last 5 cycles)
session_death_rate     = sessions_terminated / sessions_spawned (last 60 min)
```

**skeptics-watcher:**
```
skeptic_pass_rate      = VERDICT_PASS / total_verdicts (last 24h)
evidence_gate_pass_rate = passed / attempted (last 24h)
false_positive_rate    = VERDICT_PASS but 7-green not met / VERDICT_PASS (last 24h)
```

**backlog-prioritizer:**
```
zero_touch_rate        = zero_touch_prs / total_prs (last 24h)
pr_coverage_rate       = covered_prs / open_prs (current)
stale_bead_rate        = stale_beads / total_open_beads (current)
```

**Anti-stall trigger:** If any rate crosses a threshold, flag for DIAGNOSE. Thresholds are configurable per manager agent via `agentRules` or a new `evolveThresholds` config block.

---

### Phase 3: DIAGNOSE

Identify root causes. Each manager has domain-specific diagnostic rules.

**lifecycle-manager diagnostic rules:**
```
IF reaction_success_rate < 80% AND attempts > 10:
  → identify which reactions are failing
  → if send-to-agent failures: check if session is dead → escalate
  → if notify failures: log MCP mail status
  → if spawn-worker failures: check session cap → escalate to external loop

IF dedup_suppress_rate > 50%:
  → check if SHA is stable for too long (session stuck on same commit)
  → check if message content is stable for too long (repeated CI failures not advancing)

IF poll_cycle_duration_ms > 30_000:
  → check session count: many sessions = sequential polling is slow
  → check if backfillAllPRs is spawning many sessions per cycle
  → log as friction point

IF tmux_orphan_count > 0:
  → trigger tmux sweeper immediately
  → if sweep fails: escalate to external loop (worktree cleanup needed)
```

**skeptics-watcher diagnostic rules:**
```
IF false_positive_rate > 10%:
  → check if VERDICT regex is mis-matching (evidence-gate FAIL reported as PASS)
  → flag for bead creation

IF evidence_gate_pass_rate < 60%:
  → identify which format fields are missing (terminal media? repro gist?)
  → surface pattern: which worker types produce bad evidence bundles?

IF skeptic_pass_rate < 30% for 3+ cycles:
  → run code audit: is llm-eval.ts producing bad verdicts?
  → escalate to external loop for llm-eval.ts review
```

**backlog-prioritizer diagnostic rules:**
```
IF zero_touch_rate < 20% for 2+ cycles:
  → trigger chronic problem: read automation code (skeptic-cron.yml, lifecycle-manager.ts)
  → compare what code does vs what 7-green definition requires
  → create bead with specific bug found

IF pr_coverage_rate < 80%:
  → list uncovered PRs
  → dispatch workers for uncovered PRs (backlog manager can do this autonomously)

IF stale_bead_rate > 30%:
  → kill stale workers or close stale beads
  → escalate to external loop for zombie sweep
```

---

### Phase 4: PLAN

Decide what to do. Each manager classifies issues into three buckets:

| Class | Who handles | Examples |
|---|---|---|
| **Autonomous fix** | Manager itself | Config toggle, retry reaction, kill zombie session |
| **Needs worker** | Dispatch AO worker | Code changes, PR fixes, new agentRules |
| **Cross-cutting** | External loop or bead | Zero-touch regression, skeptic eval bug, new infrastructure |

**Autonomous fix criteria (ALL must be true):**
1. Fix is a config toggle or in-memory state change (no file writes, no git)
2. Fix is reversible
3. Fix does not change another manager's behavior without coordination
4. A test or metric can confirm the fix within 2 cycles

**Manager decision matrix:**
```
Condition                        → Action
─────────────────────────────────────────────────────────────────────
Dead worker session              → Autonomous: kill tmux, remove worktree, update metadata
Stuck reaction (retries > cap)  → Autonomous: increment retry cap, log escalation event
Tmux orphan session             → Autonomous: tmux kill (if sweeper enabled)
Dedup suppressing valid sends   → Autonomous: clear dedup state for this session+reaction
Poll cycle slowing              → Autonomous: log friction, schedule backfill check
PR coverage gap                  → Autonomous: dispatch worker (within session cap)
Evidence bundle missing media    → Worker: dispatch to fix PR evidence
Skeptic false positive rate > 10% → Worker: audit llm-eval.ts prompt
Zero-touch rate < 20% (chronic)  → Escalate: bead + external loop code audit
New reaction failure type        → Escalate: bead for pattern analysis
```

---

### Phase 5: RECORD

Log findings in a structured, machine-readable format.

**Two-level recording:**

1. **Manager-local observability log** — `observer.recordOperation()` with `metric: "manager_evolve.{agent}.{phase}"`. Written on every evolve cycle. Read by external loop to build cross-manager views.

2. **Structured findings log** — append to `roadmap/evolve-loop-findings.md` only when:
   - A new friction point is identified (not seen in last 5 cycles)
   - A cross-cutting issue is escalated
   - An autonomous fix was applied and verified

**Manager evolve log entry format:**
```json
{
  "timestamp": "2026-04-04T12:00:00Z",
  "manager": "lifecycle-manager",
  "cycle_id": "lifecycle-poll-20260404-1200",
  "phase": "diagnose",
  "findings": [
    {
      "type": "reaction_failure",
      "reaction": "changes-requested",
      "session_id": "ao-3252",
      "attempts": 5,
      "max_retries": 3,
      "action": "escalate"
    }
  ],
  "autonomous_fixes": [
    {
      "type": "kill_zombie_session",
      "session_id": "ao-2303",
      "reason": "tmux orphan, no AO DB record, idle > 30min"
    }
  ],
  "escalations": [
    {
      "type": "cross_cutting",
      "description": "dedup suppressing valid sends for ao-3252 for 4 consecutive cycles",
      "target": "external_loop"
    }
  ]
}
```

---

### Phase 6: FIX (Autonomous Only)

Autonomous fixes are limited to safe, reversible operations:

**Allowed autonomous fixes:**
```typescript
type AutonomousFix =
  | { type: "kill_tmux_session"; sessionId: string; reason: string }
  | { type: "clear_reaction_tracker"; sessionId: string; reactionKey: string }
  | { type: "increment_reaction_cap"; reactionKey: string; newCap: number }
  | { type: "dispatch_worker"; prNumber: number; reason: string }
  | { type: "update_session_metadata"; sessionId: string; key: string; value: string }
  | { type: "log_friction_event"; description: string; tags: string[] }
```

**Blocked from autonomous fix (requires worker or human):**
- Any file write to disk
- Any git operation
- Any `gh pr` create/merge/close
- Any config file modification
- Any new npm package or dependency change

**Guard: fix must be verifiable within 2 cycles**
After applying an autonomous fix, the next evolve cycle verifies the fix worked:
- If metric improves: record fix as successful
- If metric unchanged: revert fix, escalate
- If metric worsens: revert immediately, escalate urgently

---

### Phase 7: ESCALATE

Cross-cutting issues are escalated through a defined path:

```typescript
interface Escalation {
  type: "cross_cutting" | "chronic_problem" | "worker_required" | "infra_failure";
  source: string;          // manager agent that identified it
  description: string;
  severity: "info" | "warning" | "critical";
  evidence: string[];       // metric names and values
  suggested_bead?: {        // pre-populate bead for external loop
    title: string;
    priority: "P0" | "P1" | "P2";
    description: string;
  };
}
```

**Escalation paths:**
1. **Cross-cutting friction** → Write to `roadmap/evolve-loop-findings.md` (external loop picks up on next cycle)
2. **New bead-worthy gap** → Create bead via `br create` (lifecycle-manager can do this via `exec`)
3. **Worker dispatch needed** → Use `/claw` to dispatch worker (backlog-prioritizer and external loop can do this)
4. **Human review needed** → MCP mail to `jleechanclaw` project

---

## Assessment Capabilities

### Self-Assessment

Each manager agent assesses two things:

**A. Own health:**
```
- Is my poll/work cycle completing without errors?
- Are my reactions firing as expected?
- Is my memory/state growing unbounded (memory leak)?
- Are my API calls succeeding (GitHub, MCP mail)?
```

**B. Ecosystem health (partial view):**
```
- lifecycle-manager: Can I reach all sessions? Are tmux sessions alive?
- skeptics-watcher: Are skeptic verdicts trending correctly?
- backlog-prioritizer: Is zero-touch rate improving?
```

### Cross-Manager Coordination

Managers signal each other through the **observability log** and **bead store**:

- Manager A writes findings to observability log
- Manager B reads Manager A's latest findings at the top of its evolve cycle
- If Manager B finds a conflict (Manager A escalated something Manager B was working on), Manager B defers to Manager A and updates the bead

**Coordination protocol:**
1. Before dispatching a worker for a PR, check if a bead already exists for that PR
2. Before closing a bead, check if any other manager has escalated the same issue
3. Before modifying `agent-orchestrator.yaml`, acquire a coordination lock via a marker bead

---

## Short-term vs. Long-term Issue Handling

### Short-term (this cycle)

**Lifecycle manager handles immediately:**
- Dead tmux sessions (kill, cleanup worktree)
- Stuck workers (kill, respawn)
- Reaction retries exhausted (escalate)

**Backlog manager handles immediately:**
- Uncovered PRs (dispatch worker if session cap allows)
- 7-green PRs ready to merge (post green signal if CR approved)

### Long-term (tracked via beads)

**External loop handles:**
- Zero-touch rate regression below 20%
- Skeptic false-positive rate > 10%
- New reaction failure pattern across multiple PRs
- Tmux sweeper repeatedly failing on same session

**Triage protocol:**
```
Issue discovered
  → Is it fatal (blocks all PRs)?        → Escalate immediately, dispatch P0 worker
  → Is it chronic (>3 cycles)?           → Create bead, schedule fix
  → Is it one-off (first occurrence)?   → Log, watch next cycle
  → Is it cross-cutting (affects >1 PR)? → Escalate to external loop
```

---

## Improvement Proposals

Manager agents surface improvements in two ways:

**1. Friction events (low-friction path):**
Log a friction event with `suggested_fix: string` field. The external loop reads these and promotes common themes to beads.

**2. Beads (structured path):**
For issues requiring code changes, the manager creates a bead. The bead title follows the pattern: `{subsystem}: {diagnosis}`. Example: `lifecycle-manager: dedup suppressing valid reaction sends for sessions on same SHA`.

**Bead creation criteria:**
- Issue affects ≥2 PRs or ≥1 PR for >3 evolve cycles
- Issue requires a code change (not a config toggle)
- No existing bead covers the same root cause

---

## Safety & Guardrails

### Hard Bounds on Autonomous Action

| Action | Autonomous? | Conditions |
|---|---|---|
| Kill tmux session | Yes | tmux orphan confirmed + no AO DB record |
| Clear dedup state | Yes | session is dead or terminal |
| Increment reaction retry cap | Yes | max 2× original cap, logged |
| Dispatch worker for uncovered PR | Yes | session cap < 20 active |
| Modify `agent-orchestrator.yaml` | No — worker only | — |
| Merge or close PR | No — never | — |
| Delete worktree | No — lifecycle-worker only | — |
| Run `git push --force` | No — never | — |

### Kill Switches

**Manager-level kill switch:** Each manager has an `evolveEnabled: boolean` config flag. When `false`, the evolve phases are skipped but the core poll/work cycle continues. Default: `true`.

**External kill switch:** The external loop can set `GLOBAL_PAUSE_UNTIL_KEY` in the session metadata to pause evolve phases for a manager.

**Escalation triggers (hard stops):**
- If `reaction.escalated` fires 3+ times for the same issue in 1 hour → escalate to MCP mail
- If poll cycle fails 3 consecutive times → pause manager, alert via MCP mail
- If memory usage grows >500MB above baseline → pause manager, alert

### Anti-Stall Rules

```
IF evolve_cycle runs > 60 seconds:
  → Log warning, skip RECORD and FIX phases, proceed to next cycle
  → Alert if this happens 3 times in a row

IF no new findings for 10 consecutive cycles:
  → Log "stable — skipping diagnostic" (healthy state, not an issue)

IF same autonomous fix applied 5 times without metric improvement:
  → Revert fix, escalate (fix is not working)
  → Log: "autonomous fix {type} applied {n} times without improvement — escalating"
```

---

## Integration with Existing Infrastructure

### Hook into lifecycle-manager.ts

The evolve loop phases are implemented as a new module: `packages/core/src/manager-evolve.ts`.

**Integration points:**
1. `pollAll()` — call `runEvolveCycle()` every 5th cycle (not every tick)
2. `executeReaction()` — after each reaction execution, emit to evolve observability log
3. `checkSession()` — after session state transition, emit to evolve observability log

**No new timers.** The evolve phases run synchronously inside `pollAll()`, bounded by a cycle counter.

```typescript
// In packages/core/src/lifecycle-manager.ts, inside pollAll():
let evolveCycleCounter = 0;
// ...
// Every 5th poll cycle (~5 min at 60s default interval)
if (++evolveCycleCounter % 5 === 0) {
  await runEvolveCycle({ config, registry, sessionManager, observer });
}
```

### Hook into skeptic-cron.yml (skeptic-cron worker)

The skeptic-watcher manager runs as an AO worker dispatched by `skeptic-cron.yml`. It reads:
- PR comments for VERDICT counts
- Evidence Gate check results from `evidence-gate.yml`
- Zero-touch rate from the zero-touch log

After each skeptic evaluation, the worker runs a lightweight measure cycle and escalates as needed.

### Hook into bead tracker

Manager agents create beads using the `br` CLI or the `beads` API. The bead store is shared across all managers and the external loop — this is the primary coordination mechanism.

```bash
# Example: lifecycle-manager creates a bead for a cross-cutting issue
br create \
  --priority P1 \
  --title "lifecycle-manager: dedup suppressing valid sends for ao-3252 (4+ cycles)" \
  --body "Dedup is blocking reaction delivery for session ao-3252 despite SHA changes..."
```

### Hook into zero-touch metrics

Manager agents read from `docs/zero-touch-by-operator.md` (the canonical metric doc) and write their local measurements to the observability log. The external loop aggregates.

---

## Configuration

### New `evolveConfig` Block in `agent-orchestrator.yaml`

```yaml
projects:
  agent-orchestrator:
    evolveConfig:
      # Enable/disable evolve phases for this manager
      enabled: true

      # How often to run evolve cycle (every N poll/work cycles)
      cycleInterval: 5

      # Maximum duration for one evolve cycle (ms)
      maxCycleDurationMs: 60_000

      # Thresholds that trigger diagnosis
      thresholds:
        reactionSuccessRateMin: 0.80
        dedupSuppressRateMax: 0.50
        pollCycleDurationMaxMs: 30_000
        zeroTouchRateMin: 0.20
        skepticPassRateMin: 0.50
        evidenceGatePassRateMin: 0.60
        prCoverageRateMin: 0.80
        staleBeadRateMax: 0.30

      # What the manager can do autonomously (allowlist)
      autonomousActions:
        - kill_tmux_session        # only if tmux orphan confirmed
        - clear_reaction_tracker   # only if session is dead
        - increment_reaction_cap   # max 2x original
        - dispatch_worker          # only if session cap < 20 active
        - log_friction_event

      # Hard stop: escalate after N consecutive failures
      escalateAfterConsecutiveFailures: 3

      # Anti-stall: skip diagnostic after N stable cycles
      stableCyclesBeforeSkip: 10

      # Self-fix verification: how many cycles to wait before checking fix worked
      fixVerificationCycles: 2
```

### Per-Agent Overrides

Each manager can override the global `evolveConfig` in its own project or agent section:

```yaml
projects:
  skeptic-watcher:
    evolveConfig:
      thresholds:
        skepticPassRateMin: 0.40    # skeptic is harder to pass than general health
        evidenceGatePassRateMin: 0.70
      autonomousActions:
        - log_friction_event        # skeptic-watcher only logs, never fixes
        - dispatch_worker           # but it can dispatch workers
```

---

## Anti-Stall Rules (Detailed)

| Rule | Trigger | Response |
|---|---|---|
| Evolve cycle timeout | `runEvolveCycle()` exceeds `maxCycleDurationMs` | Skip RECORD/FIX, log warning, continue next cycle |
| Stable state | Same findings for `stableCyclesBeforeSkip` cycles | Log "stable — skipping diagnostic", reduce log verbosity |
| Autonomous fix looping | Same fix applied 5× without metric improvement | Revert fix, escalate, log as chronic |
| Escalation flooding | Same issue escalated 3× in 1h | Upgrade to MCP mail, pause evolve for this manager |
| Poll cycle degradation | `pollAll()` duration > 2× previous median | Log correlation with evolve cycle (is evolve causing the slowdown?) |
| Memory growth | Node.js heapDelta > 500MB above baseline | Pause manager, alert via MCP mail, log heap snapshot |
| Cross-manager conflict | Two managers escalate the same PR/bead | Older escalation wins; newer manager defers and updates bead |

---

## Implementation Plan

### Phase 1: Core Module (bd-xxxx)
- Create `packages/core/src/manager-evolve.ts`
- Implement OBSERVE, MEASURE, DIAGNOSE, RECORD phases for lifecycle-manager
- Hook into `pollAll()` every 5th cycle
- Emit structured observability log entries
- **Deliverable:** lifecycle-manager emits evolve findings to observability log

### Phase 2: Autonomous Fixes (bd-xxxx)
- Implement autonomous fix execution in `manager-evolve.ts`
- Add fix verification (2-cycle check)
- Add anti-stall rules for looping fixes
- **Deliverable:** lifecycle-manager can autonomously kill tmux orphans and clear dedup state

### Phase 3: Skeptic-Watcher (bd-xxxx)
- Create `scripts/skeptic-watcher-manager.ts` (runs as AO worker)
- Hook into skeptic-cron.yml dispatch
- Implement skeptic-specific OBSERVE → MEASURE → DIAGNOSE → ESCALATE
- **Deliverable:** skeptic-watcher surfaces false-positive patterns as beads

### Phase 4: Backlog Manager (bd-xxxx)
- Extend backlog-prioritizer with evolve phases
- Implement PR coverage detection and autonomous worker dispatch
- Implement zero-touch rate tracking and chronic problem detection
- **Deliverable:** backlog manager maintains PR coverage ≥ 80% autonomously

### Phase 5: Coordination Layer (bd-xxxx)
- Implement cross-manager coordination via bead store
- Add escalation deduplication (same issue escalated by multiple managers)
- Add MCP mail escalation for critical issues
- **Deliverable:** managers coordinate without conflicting, critical issues reach human

---

## Open Questions

1. **How do manager agents read each other's observability logs?** The current `createProjectObserver` writes to the project observability dir. We need a shared read path that all managers can access. Options: (a) all managers write to a common `roadmap/evolve-observability.jsonl`, (b) managers publish to MCP mail as structured events, (c) external loop is the only aggregator.

2. **Who is the "owner" of a bead created by a manager?** Beads created autonomously by managers should be tagged with the manager's ID so the external loop knows who to follow up with.

3. **What happens when two managers dispatch workers for the same PR?** The session cap and `backfillAllPRs` dedup should prevent this, but we need explicit conflict detection.

4. **How do we prevent evolve phases from accumulating state?** The observability log entries should have TTLs (e.g., 24h for metric snapshots, 7d for friction events).

5. **Should manager evolve findings be committed to git?** Yes — `roadmap/evolve-loop-findings.md` is committed. But manager-local observability logs are not committed (they're ephemeral and large).
