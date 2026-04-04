# Manager AO Evolve Loop — Architecture Design

**Date:** 2026-04-04
**Status:** Design — for review and implementation
**Scope:** `jleechanorg/agent-orchestrator` fork

---

## Context

The existing `/eloop` skill (~/.claude/skills/eloop.md) runs an **external** 12-hour autonomous evolution loop as a separate Claude Code session. It observes the AO ecosystem, measures zero-touch rate, diagnoses friction, creates beads, and dispatches fixes via `/claw`.

This design proposes extending that capability **inside** manager AO agents themselves — so the lifecycle-manager, skeptic-watcher, and other system managers each run a lightweight evolve loop as part of their normal operation, rather than requiring a separate external session.

---

## Problem Statement

Today:

- The `/eloop` is a **single external agent** that watches everything — it has broad awareness but shallow depth per subsystem.
- The lifecycle-manager has **no self-diagnosis** — it can react to events but cannot observe patterns and improve its own configuration.
- The skeptic-watcher has **no feedback loop** — it evaluates PRs but does not track its own accuracy or tune its behavior.
- Subsystem failures are caught only when `/eloop` runs, or when a human notices. There is a latency gap of up to 12 hours.
- If `/eloop` dies, all autonomous improvement stops.

Manager-agent evolve loops close this gap by distributing evolve-capable self-assessment into the systems that are **always running**.

---

## Design Principles

1. **Manager scope = evolve scope.** Each manager agent evolves only within its own subsystem. Cross-subsystem issues are surfaced as beads.
2. **Non-blocking.** Evolve phases run at the end of normal operation cycles, not as blocking steps that delay core functions.
3. **Bounded autonomy.** Each phase has explicit escalate conditions. Managers do not attempt cross-system code changes without human approval.
4. **Composable with existing infra.** Reuses the lifecycle-manager poll loop, reaction engine, bead store, and skeptic infrastructure rather than replacing them.
5. **Observable.** Every evolve phase writes structured records to an evolve-log so the chain is auditable.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Manager AO Agents                         │
├──────────────────┬──────────────────┬──────────────────────┤
│ lifecycle-       │ skeptic-         │ merge-gate-          │
│ manager          │ watcher          │ watcher               │
│                  │                  │                       │
│ [evolve loop]    │ [evolve loop]    │ [evolve loop]        │
│                  │                  │                       │
│ OBSERVE: sessions│ OBSERVE: gates   │ OBSERVE: merge        │
│ MEASURE: metrics │ MEASURE: pass/fail│ MEASURE: latency      │
│ DIAGNOSE: gaps   │ DIAGNOSE: patterns│ DIAGNOSE: blocks     │
│ PLAN: reactions  │ PLAN: prompts    │ PLAN: escalations    │
│ FIX: config/hook│ FIX: prompt tune  │ FIX: admin action    │
│ RECORD: evolve-  │ RECORD: eval-log │ RECORD: audit log    │
│      log         │                  │                       │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         └──────────────────┴─────────────────────┘
                            │
                     ┌──────▼──────┐
                     │  Bead Store  │  (escalation, cross-subsystem)
                     │  evolve-log  │  (structured records)
                     │  metrics/    │
                     └─────────────┘
```

---

## Per-Agent Evolve Loop Phases

### 1. Lifecycle-Manager Evolve Loop

**Trigger:** End of each `pollAll()` cycle (when sessions are being checked).

**OBSERVE — What it watches:**
- Session state transitions over time: `spawning → working → pr_open → ...`
- Worker productivity: time between last-output and current-output per session
- PR coverage: open PRs with no active session (via `backfillUncoveredPRs`)
- Reaction firing frequency: which reactions fire most often, which never fire
- Session spawn latency: time from PR open to first session spawned
- Dead session rate: how many sessions reach terminal state without a PR
- tmux orphan accumulation rate

**MEASURE — What it computes:**
- Zero-touch PR rate per rolling window (which reactions contribute most to failures)
- `stuck` transition rate (sessions that become stuck)
- Backfill latency: median time between PR open and worker spawn
- Reaction escalation rate: how often reactions escalate vs auto-resolve
- Session abandonment rate: sessions killed or exited without producing a PR
- Productivity stall rate: sessions alive but making no progress

**DIAGNOSE — What it identifies:**
- Reactions that are misconfigured (firing on wrong events, wrong action type)
- Session patterns that predict stuck-ness (e.g., same output 3+ cycles)
- Beads that have been in_progress > 48h with no active worker
- Configuration drift: agentRules that differ from canonical templates
- Hook gaps: PreToolUse/PostToolUse hooks missing coverage for common failure modes
- tmux sweeper that keeps killing the same session pattern (symptom of spawn loop)
- `backfillAllPRs` failing silently (PRs uncovered for > 30min)

**PLAN — What it decides:**
- Whether a reaction config tweak is safe to apply autonomously (e.g., increasing retry cap)
- Whether to create a bead for a detected friction point
- Whether to escalate to human (config change, hook addition, code-level fix)
- Whether a worker stuck pattern needs a new reaction or a harness fix

**FIX — What it does autonomously (within scope):**
- Tunes reaction `retries`, `escalateAfter`, and `auto` flags via config update (agentRules changes go through PR)
- Creates beads for new friction points
- Updates `startupGracePeriodMs` if startup kills are detected
- Adjusts backfill interval if PRs are staying uncovered too long
- Tags sessions with triage flags (e.g., "may be stuck", "needs review")

**What it escalates:**
- New hook needed (PreToolUse/PostToolUse)
- agentRules change needed
- Core lifecycle-manager code bug
- Cross-subsystem issue (e.g., PR uncovered because SCM plugin is down)

**RECORD:**
```
evolve-log/lifecycle-manager/{date}.jsonl
{ts, phase:"diagnose", finding:"reaction ci-failed escalates 80%", action:"create_bead", bead_id:"bd-xxx"}
{ts, phase:"fix", action:"tune_retries", reaction:"ci-failed", from:3, to:5}
{ts, phase:"escalate", reason:"hook gap: no guard for gh pr close", severity:"P1"}
```

---

### 2. Skeptic-Watcher Evolve Loop

**Trigger:** After each `ao skeptic verify` run (async, non-blocking).

**OBSERVE — What it watches:**
- Per-evaluation: which gate(s) failed, evaluation duration, model used
- PR patterns: which PR types/sizes/repo paths consistently fail skeptic
- False positive rate: skeptic FAIL but CR APPROVED (or vice versa — need to track)
- Skeptic PASS rate: how many PRs pass vs fail vs SKIP
- SKIP reasons: infra failures (no API keys), timeout, API errors
- Prompt effectiveness: which evaluation criteria catch real issues vs false alarms

**MEASURE — What it computes:**
- Skeptic PASS/FAIL/SKIP rate per rolling window
- False positive rate: FAIL verdicts reversed by human review
- Average evaluation duration (for timeout tuning)
- Per-criterion failure rate: which evaluation criteria are most commonly violated
- SKIP rate: fraction of evaluations that fail due to infra (should trend to 0)

**DIAGNOSE — What it identifies:**
- Criteria that generate false positives (catching issues that aren't real)
- Criteria that never fire (dead criteria — opportunity to simplify prompt)
- SKIP patterns: same infra failure repeated → suggests a systemic issue
- Prompt drift: LLM evaluation becoming more lenient or strict over time without config change
- Model inconsistency: different verdicts for equivalent PRs (different model runs)

**PLAN — What it decides:**
- Whether to tune skeptic prompt (more specific criteria, less noise)
- Whether to add a new evaluation criterion
- Whether to mark a criterion as noisy (de-weight in aggregation)
- Whether to escalate a systemic false-positive pattern

**FIX — What it does autonomously:**
- Adjusts `SKEPTIC_CUSTOM_PROMPT` via project config (with PR for permanent changes)
- Tunes SKIP retry threshold (e.g., if > 50% of SKIPs are infra, improve error handling)
- Creates beads for false-positive patterns
- Tags SKIP evaluations for infra audit

**What it escalates:**
- Skeptic prompt change needed that requires code change
- LLM model swap needed (e.g., Codex → Claude for better accuracy)
- Evidence gate producing contradictory verdicts
- Evaluator model consistently wrong on specific criterion

**RECORD:**
```
evolve-log/skeptic-watcher/{date}.jsonl
{ts, pr:123, verdict:"PASS", duration_ms:45000, model:"codex", gates_failed:[]}
{ts, pr:124, verdict:"FAIL", duration_ms:120000, model:"codex", gates_failed:["gate3_cr_approved"]}
{ts, phase:"diagnose", finding:"gate3 false_positive_rate=23%", action:"create_bead"}
{ts, phase:"fix", action:"tune_prompt", criterion:"gate3", change:"add context requirement"}
```

---

### 3. Merge-Gate-Watcher Evolve Loop

**Trigger:** After each merge attempt (success or failure).

**OBSERVE — What it watches:**
- Per-PR: which gate(s) failed, how long PR was open, what blocked it
- Gate latency: time each PR spent blocked at each gate
- Auto-merge success/failure rate
- Admin merge rate: how often a human had to merge (gate automation failure)
- Merge conflict frequency and resolution time
- CR state transitions: how many round-trips between CHANGES_REQUESTED and APPROVED

**MEASURE — What it computes:**
- Gate-by-gate pass rate (which gate is the bottleneck)
- Average time-to-merge for zero-touch PRs vs non-zero-touch
- Admin-merge rate: fraction of PRs needing human merge
- CR round-trip rate: average number of CHANGES_REQUESTED cycles before APPROVED
- Merge failure rate: PRs that fail gates even after all green signals

**DIAGNOSE — What it identifies:**
- Which gate most commonly blocks PRs (the bottleneck gate)
- CR patterns that predict multiple round-trips (early signal to dispatch CR-fixing worker proactively)
- Merge conflicts that recur on specific file patterns → suggest need for integration tests
- PRs stuck at 6-green for > 1h (skeptic evaluation pending) → investigate skeptic stall

**PLAN — What it decides:**
- Whether to add a new gate or remove a noisy gate
- Whether a specific PR type needs a different merge path
- Whether to pre-dispatch a CR-fixing worker before CHANGES_REQUESTED fires

**FIX — What it does autonomously:**
- Updates `mergeGate` config (add/remove gates, change thresholds)
- Dispatches CR-fixing worker proactively when CR signals pending review
- Creates beads for recurring merge blocks

**What it escalates:**
- New CI check needed as a gate
- Skeptic gate producing false failures blocking merge
- CR automation gap (CR keeps requesting changes that agents can't address)

**RECORD:**
```
evolve-log/merge-gate/{date}.jsonl
{ts, pr:125, gates:[1,2,3,5], blocked_at:"gate3", duration_h:2.1, merged:"auto"}
{ts, pr:126, gates:[1,2,3,4,5,6,7], blocked_at:"gate7", duration_h:18.4, merged:"admin"}
{ts, phase:"diagnose", finding:"gate7 is bottleneck for 67% of PRs", action:"create_bead"}
```

---

## Anti-Stall Rules

Each manager-agent evolve loop implements these stall-prevention rules:

| Rule | Trigger | Action |
|---|---|---|
| **Same-finding loop** | Same diagnose finding 3+ consecutive cycles | Escalate immediately; do not keep re-diagnosing |
| **No-progress escalation** | 0 fixes applied for 5+ cycles despite active problems | Escalate to human with findings summary |
| **Context exhaustion** | Manager's own context > 80% used | Flush evolve-log to disk, skip fix phase this cycle |
| **API exhaustion** | Rate limit hit during OBSERVE/MEASURE | Abort cycle, resume next interval |
| **Dead-loop detection** | Diagnose outputs same items 3x in a row | Log stall, escalate, skip fix phase |
| **Model timeout** | Skeptic evaluation > 5min | SKIP, log, retry next cycle (max 3 retries) |
| **Config drift guard** | Config changed externally mid-cycle | Re-read config at start of each cycle |

---

## Coordination Between Manager Agents

### Problem
Multiple manager agents running evolve loops concurrently could create conflicting actions (e.g., merge-gate-watcher lowers a threshold while lifecycle-manager raises it).

### Solution: Shared evolve-log + priority ordering

```
1. Each manager writes evolve records atomically to its own evolve-log file.
2. A lightweight coordination lock (file-based: evolve-log/.lock) prevents
   simultaneous writes to shared state (beads, config).
3. Priority ordering when actions conflict:
   - lifecycle-manager fixes > skeptic-watcher fixes > merge-gate fixes
   - (lifecycle-manager is closest to core; skeptic and merge-gate are leaf systems)
4. Cross-manager findings are surfaced as beads, not acted on directly.
5. The bead store is the coordination artifact: managers write findings as beads,
   and only the lifecycle-manager (or a human) dispatches cross-system fixes.
```

### Coordination protocol:
```
If manager-A detects cross-subsystem issue:
  → Create bead with type="cross-subsystem"
  → Tag bead with all relevant subsystems
  → Lifecycle-manager owns cross-subsystem bead resolution
  → Other managers skip fixing tagged beads
```

---

## Integration with Existing Infrastructure

### Hook into lifecycle-manager.ts

```
In pollAll() after all session checks complete:

  // === MANAGER EVOLVE LOOP (non-blocking) ===
  void runLifecycleEvolveCycle({ sessions, config, registry, ... }).catch(err =>
    console.warn("[evolve] lifecycle evolve cycle failed:", err)
  )
```

The `runLifecycleEvolveCycle` function is defined in a new module:
`packages/core/src/evolve/lifecycle-evolve-loop.ts`

It is called asynchronously (fire-and-forget with error logging) so it never blocks the poll loop.

### Hook into skeptic-cron-local.ts

```
After ao skeptic verify completes (success or failure):

  // === SKEPTIC EVOLVE LOOP ===
  void runSkepticEvolveCycle({ pr, verdict, duration, model, gatesFailed }).catch(err =>
    console.warn("[evolve] skeptic evolve cycle failed:", err)
  )
```

### Hook into merge-gate.ts

```
After merge attempt (success or failure):

  // === MERGE-GATE EVOLVE LOOP ===
  void runMergeGateEvolveCycle({ pr, gates, blockedAt, duration, mergedBy }).catch(err =>
    console.warn("[evolve] merge-gate evolve cycle failed:", err)
  )
```

### New config fields

In `OrchestratorConfig` / `agent-orchestrator.yaml`:

```yaml
projects:
  agent-orchestrator:
    evolve:
      enabled: true                    # master switch for all evolve loops
      lifecycleManager:
        enabled: true
        diagnoseInterval: 5m            # run diagnose every N poll cycles
        fixEnabled: true                # allow autonomous config fixes
        maxAutonomousFixesPerCycle: 3   # cap self-changes per cycle
        escalateAfter: 48h              # escalate if finding unresolved
      skepticWatcher:
        enabled: true
        recordVerdicts: true            # write to evolve-log/skeptic-watcher/
        tunePromptEnabled: false        # require PR for prompt changes
      mergeGateWatcher:
        enabled: true
        recordMerges: true
        bottleneckThreshold: 0.4       # create bead if gate blocks >40% of PRs
    reactions:
      # existing reactions unchanged
```

### Files to create

```
packages/core/src/evolve/
  lifecycle-evolve-loop.ts    # lifecycle-manager evolve phases
  skeptic-evolve-loop.ts       # skeptic-watcher evolve phases
  merge-gate-evolve-loop.ts    # merge-gate evolve phases
  evolve-log.ts                # shared evolve-log writer (atomic JSONL)
  evolve-types.ts              # shared types for evolve records
  evolve-config.ts             # evolve config schema and defaults

docs/
  manager-evolve-loop-design.md # this document
```

### Integration with skeptic-cron.yml

The GHA skeptic-cron workflow posts trigger comments; the lifecycle-manager's `runLocalSkepticCron` picks them up and runs evaluations. The skeptic evolve loop hooks into `runLocalSkepticCron` to record verdicts.

---

## Safety & Guardrails

### Autonomous action bounds

| Manager | Can do autonomously | Must escalate |
|---|---|---|
| lifecycle-manager | Tune `retries`, `escalateAfter`; create beads; tag sessions | Add/remove reactions; change agentRules; modify hook scripts |
| skeptic-watcher | Record verdicts; tune SKIP thresholds; create beads | Change skeptic prompt; change model; add/remove criteria |
| merge-gate-watcher | Record merges; tune gate thresholds; create beads | Add/remove gates; change merge strategy; override skeptic verdicts |

### Escalation triggers

Every evolve loop has explicit escalate conditions:

```typescript
const ESCALATE_CONDITIONS = {
  // Same finding repeated without resolution
  staleFinding: (finding, cycles) => cycles >= 3 ? escalate(finding) : null,

  // Cross-subsystem issue detected
  crossSubsystem: (finding) => escalate(finding, { type: 'cross-subsystem' }),

  // Config change needed that requires code
  configRequiresCode: (finding) => escalate(finding, { type: 'code-change' }),

  // Safety boundary hit (e.g., hook being added)
  safetyBoundary: (finding) => escalate(finding, { type: 'safety-escalation' }),

  // Repeated failure to self-fix
  selfFixExhausted: (finding, attempts) => attempts >= 3 ? escalate(finding) : null,
};
```

### Kill switches

```yaml
evolve:
  globalKillSwitch: false          # master kill — set to true to disable all evolve loops
  lifecycleManager:
    disabled: false
    fixKillSwitch: false            # disable autonomous fixes only
  skepticWatcher:
    disabled: false
  mergeGateWatcher:
    disabled: false
```

### Audit trail

Every evolve action (observe, measure, diagnose, plan, fix, escalate) is written to the evolve-log with:
- Timestamp
- Manager identity (lifecycle-manager, skeptic-watcher, merge-gate-watcher)
- Cycle ID (increments each time evolve runs)
- Phase
- Finding (structured)
- Action taken
- Outcome (if known)

This enables post-hoc analysis of manager decisions and prevents silent failures.

---

## Short-term vs. Long-term Issue Handling

### Short-term (this cycle)
Issues that can be resolved within one evolve cycle are handled directly:
- Reaction config tuning (retries, escalateAfter)
- Bead creation for new friction points
- Session tagging for human review
- SKIP retry for transient infra failures

### Long-term (tracked as beads)
Issues that require more than one cycle or cross-system coordination are tracked as beads:
- New hook needed → `type: "hook-needed"`, `priority: P1`
- AgentRules change → `type: "agent-rules-change"`, linked to PR
- Core bug → `type: "core-bug"`, `priority: P0`
- Cross-subsystem → `type: "cross-subsystem"`, managed by lifecycle-manager

### Backpressure mechanism

When the evolve loop detects that beads are accumulating faster than they are being resolved:
- Log a `backpressure` event to evolve-log
- Escalate to human with summary of pending beads and oldest bead age
- Temporarily increase evolve cycle frequency (from every 5 cycles to every 2)
- If backpressure persists for > 24h, pause evolve loop and alert human

---

## Improvement Proposals

Manager agents surface improvements as structured proposals in the evolve-log:

```json
{
  "ts": "2026-04-04T12:00:00Z",
  "manager": "lifecycle-manager",
  "type": "improvement_proposal",
  "proposal": {
    "title": "Add PreToolUse hook for gh pr close guard",
    "rationale": "3 PRs closed without merge in 48h by agents — no guard exists",
    "impact": "P1: prevents accidental PR destruction",
    "scope": "hook script + agentRules update",
    "autoApplicable": false,
    "beadId": null
  }
}
```

Improvement proposals are surfaced to humans via MCP mail (periodic digest) and via bead creation when scoped.

---

## Assessment Capabilities

### System health scoring

Each manager computes a health score (0–100) per cycle:

```
lifecycle-manager health = weighted(
  sessionSuccessRate:    40%,  // sessions reaching productive state
  reactionSuccessRate:   25%,  // reactions auto-resolving vs escalating
  prCoverageRate:       20%,  // open PRs with active session
  productivityRate:     15%   // sessions making progress
)

skeptic-watcher health = weighted(
  passRate:             50%,  // PASS verdicts / total evaluations
  infraReliability:     30%,  // 1 - SKIP rate
  falsePositiveRate:    20%   // FAIL reversed by human / total FAIL
)

merge-gate-watcher health = weighted(
  autoMergeRate:        50%,  // auto-merged / total merged
  gatePassRate:         30%,  // PRs reaching 7-green / total PRs
  bottleneckScore:      20%   // 1 - (blocked_count / total_evaluations)
)
```

Health scores are written to evolve-log and used by `/auton` to provide a quick system health snapshot.

### Health trend tracking

```
{ts, manager:"lifecycle-manager", health:72, trend:"↓", reason:"prCoverage dropped from 85% to 61%"}
```

If health drops below 50% or drops > 15 points in one cycle, an urgent escalation is triggered.

---

## Configuration Reference

### agent-orchestrator.yaml additions

```yaml
projects:
  agent-orchestrator:
    # === EXISTING (unchanged) ===
    backfillAllPRs: true
    sessionPrefix: ao
    reactions:
      ci-failed:         { action: send-to-agent, retries: 3, ... }
      changes-requested:  { action: send-to-agent, retries: 3, ... }
      approved-and-green: { action: auto-merge, auto: true, ... }
      # ... existing reactions

    # === NEW: EVOLVE CONFIG ===
    evolve:
      enabled: true
      lifecycleManager:
        enabled: true
        diagnoseIntervalCycles: 5    # run diagnose every 5 poll cycles
        fixEnabled: true
        maxAutonomousFixesPerCycle: 3
        escalateAfter: 48h
        healthThreshold: 50           # below this → urgent escalation
      skepticWatcher:
        enabled: true
        recordVerdicts: true
        tunePromptEnabled: false     # always require PR for prompt changes
        evalTimeoutMs: 300000         # 5 min
        maxSkipsBeforeEscalate: 5
      mergeGateWatcher:
        enabled: true
        recordMerges: true
        bottleneckThreshold: 0.4
        autoMergeEnabled: true
        adminMergeAlertThreshold: 3  # alert after 3 admin merges in 24h
    taskQueue:
      enabled: true
      maxConcurrent: 3
      # (existing taskQueue config unchanged)
```

### agentRules additions (per project)

```yaml
agentRules: |
  # Existing rules unchanged

  # Manager evolve loop instructions
  ## If you receive a message tagged [evolve:assess], run a self-assessment
  ## of your current state and report: health score, active findings, pending beads.
  ## Format response as structured JSON per docs/manager-evolve-loop-design.md.
```

---

## Open Questions

1. **Single evolve-log vs per-manager files?** Per-manager files (as designed above) are safer for concurrency but harder to query. Consider a shared append-only evolve-log with a lightweight index.

2. **Should evolve loops write to beads directly or via a review step?** Currently designed to write beads directly (fast, autonomous). Consider requiring human review for P0/P1 beads to prevent bead spam.

3. **Cross-manager coordination via file lock vs message queue?** File lock is simpler but doesn't scale past ~5 managers. If this architecture expands, consider MCP mail or a dedicated message queue.

4. **Health score weights — are these the right priorities?** The weights (session success 40%, reaction success 25%, etc.) are initial guesses. Should be tuned based on what actually predicts zero-touch failure.

5. **Should the skeptic-watcher evolve loop tune prompts autonomously or always require a PR?** Designed as "require PR for prompt changes" by default with `tunePromptEnabled: false`. This is conservative — the skeptic prompt is safety-critical. Revisit after the evolve loop has been stable for 2 weeks.

6. **Evolve loop for which other manager agents?** PR-babysitter (dispatched worker for specific PRs) and productivity-checker are natural next candidates. Document the pattern for adding new manager agents.

---

## Implementation Phases

### Phase 1: Core infrastructure (bd-????)
- Create `packages/core/src/evolve/evolve-types.ts` — shared types
- Create `packages/core/src/evolve/evolve-log.ts` — atomic JSONL writer
- Add `evolve` config schema to `types.ts` and `config.ts`
- Add `evolve` section to `agent-orchestrator.yaml` with defaults

### Phase 2: Lifecycle-manager evolve loop (bd-????)
- Create `packages/core/src/evolve/lifecycle-evolve-loop.ts`
- Hook into `pollAll()` — non-blocking, runs after session checks
- Implement OBSERVE, MEASURE, DIAGNOSE phases
- Implement BEAD creation for findings
- Implement config-tuning for reaction params
- Add evolve-log writes for all phases

### Phase 3: Skeptic-watcher evolve loop (bd-????)
- Extend `skeptic-cron-local.ts` with evolve hook
- Create `packages/core/src/evolve/skeptic-evolve-loop.ts`
- Implement verdict recording and pattern detection
- Implement false-positive tracking
- Add bottleneck detection for criteria

### Phase 4: Merge-gate-watcher evolve loop (bd-????)
- Hook into `merge-gate.ts` post-merge events
- Create `packages/core/src/evolve/merge-gate-evolve-loop.ts`
- Implement gate bottleneck detection
- Implement CR round-trip tracking
- Add admin-merge alert

### Phase 5: Health scores + MCP mail digest (bd-????)
- Implement health score computation in each evolve loop
- Add MCP mail digest: periodic summary of manager health and findings
- Add `/auton` integration: surface evolve findings in autonomy diagnostic

### Phase 6: Anti-stall hardening (bd-????)
- Implement all Anti-Stall Rules
- Add evolve-loop monitoring (is it running? is it stalling?)
- Add evolve-log rotation (prevent unbounded growth)
- Add evolve-loop tests
