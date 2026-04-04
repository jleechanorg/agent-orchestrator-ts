# Manager AO Evolve Loop — Design

**Bead:** bd-evolve-mgr (TBD — create after merge)
**Date:** 2026-04-04
**Status:** Design
**Branch:** `feat/manager-evolve-loop-design`

---

## Context

Manager tmux sessions (`ao-orchestrator`, `jc-orchestrator`, `wa-orchestrator`, etc.) are spawned via `ao start [project]` and injected with an orchestrator prompt via `orchestrator-prompt.ts`. They are currently **passive and reactive** — they display a dashboard, respond to reactions fired by `lifecycle-manager.ts`, but do not proactively scan the system or run self-assessment loops.

The `/eloop` skill (`.claude/skills/evolve_loop.md`) runs a 12-hour autonomous evolution loop externally, but it is:
- Operated by a human or agent session, not embedded in manager sessions
- Not integrated into orchestrator prompt generation
- Not aware of per-project manager state

**Composio upstream** uses the orchestrator purely as a reactive tool (no evolve loop, no proactive scanning, no autonomous fix dispatch, no 7-green gate). This design explicitly contrasts with that model.

---

## Gap Analysis — What Is NOT Implemented

| Gap | Where it belongs | Impact |
|-----|-----------------|--------|
| No proactive assessment in orchestrator sessions | `orchestrator-prompt.ts` | Manager agents are blind between reaction events |
| No evolve loop embedded in manager tmux sessions | `orchestrator-prompt.ts` injection | External `/eloop` cannot see per-manager state |
| No shared knowledge base for multi-manager coordination | New file + `orchestrator-prompt.ts` | Managers can't avoid duplicate work |
| No zero-touch metric tracking in manager sessions | `orchestrator-prompt.ts` + config types | Managers don't know their own effectiveness |
| No friction auto-detection in orchestrator context | `orchestrator-prompt.ts` + `recovery/manager.ts` | Patterns of failures go undiagnosed |
| No autonomous fix dispatch from manager sessions | `orchestrator-prompt.ts` + `agentRules` | Managers can observe but not act |
| `orchestratorRules` field exists but carries no evolve loop content | `config.ts` types + `orchestrator-prompt.ts` | Extension point is dormant |

---

## Design

### 1. Architecture — Two Loops, Two Concerns

```
lifecycle-manager.ts (Node.js process)
  └── Polling loop (every ~5 min)
       ├── Reactive: fires reactions on events (ci-failed, changes-requested, etc.)
       └── executeReaction → send-to-agent, auto-merge, notify
            │
            ▼
Manager tmux session (ao-orchestrator, jc-orchestrator, ...)
  ├── orchestrator-prompt.ts — injected evolve loop instructions
  ├── Evolve Loop (lightweight per-poll OBSERVE; full MEASURE→DIAGNOSE→PLAN→FIX on anomaly)
  ├── Shared Knowledge Base (~/.ao-evolve-knowledge/*.jsonl)
  └── Dispatch → ao spawn, ao send, ao session kill, config edit
```

**Two separate concerns:**
- `lifecycle-manager.ts` handles reactive event routing — unchanged
- Manager evolve loop handles proactive self-assessment and autonomous dispatch — new

### 2. Injection Point — `orchestrator-prompt.ts`

Add an `EvolveLoopConfig` section to `generateOrchestratorPrompt()`:

```typescript
// New config type in types.ts
export interface EvolveLoopConfig {
  enabled?: boolean;
  pollCadence?: "lightweight" | "standard"; // lightweight = every poll; standard = every 10min
  autonomousFixScopes?: string[]; // e.g. ["config-edit", "claw-dispatch", "bead-create"]
  knowledgeBasePath?: string;
}

// In ProjectConfig:
evolveLoop?: EvolveLoopConfig;
```

When `evolveLoop?.enabled === true`, append evolve loop instructions to the generated prompt. This keeps the loop opt-in per project.

### 3. Evolve Loop Phases — Manager Context

Adapt the 6-phase `/eloop` skill for the manager tmux context. All phases run within the orchestrator's Claude Code session.

#### Phase 1: OBSERVE (every poll cycle — lightweight)
- Read tmux pane output for each worker session (capture last 20 lines)
- Check `ao session ls` for worker states
- Check open PRs via `gh api` REST (no GraphQL — always REST)
- Check for cold PRs (open >3h with no activity)
- Check lifecycle log for recent reaction outcomes
- **Fast path**: if nothing abnormal, output "all clear" and exit

#### Phase 2: MEASURE (on anomaly detected)
- Calculate zero-touch rate for this project (merged [agento] PRs / total merged PRs, rolling 24h)
- Compute: worker health score, average PR cycle time, reaction failure rate
- Log snapshot to knowledge base JSONL

#### Phase 3: DIAGNOSE (on anomaly detected)
- Classify the anomaly: stuck worker, cold PR, reaction failure, friction pattern
- Run `/harness` on systemic issues (delegate to a worker, don't run in manager)
- Check bead tracker — is this already tracked?
- Check knowledge base — has another manager already diagnosed this?

#### Phase 4: PLAN (on anomaly confirmed)
- P0: Fix blocking multiple PRs (dispatch immediately)
- P1: Systemic friction (create bead + dispatch fix)
- P2: Improvement proposals (record in roadmap, defer unless capacity available)

#### Phase 5: FIX (on plan ready)
- Dispatch via `/claw` (default) — `ao spawn` worker for the fix
- Dispatch via `/antig` — if tmux cap is hit, use Antigravity IDE
- Direct config edit — for `agentRules` changes that don't need a PR
- **Never** `gh pr merge` from the manager session — always delegate to lifecycle-manager reaction

#### Phase 6: RECORD (end of every cycle)
- Append finding to `~/.ao-evolve-knowledge/{projectId}.jsonl`
- Create/update beads with `br create` or `br update`
- Append to `roadmap/evolve-loop-findings.md`

### 4. Shared Knowledge Base

Path: `~/.ao-evolve-knowledge/{projectId}.jsonl` (one file per project)

Schema per entry:
```jsonl
{"ts":"ISO8601","manager":"ao-orchestrator","phase":"DIAGNOSE","finding":"cold_prs","detail":{"prs":[123,124]},"bead":null,"dispatched":true,"dispatch_method":"claw","dispatched_to":"jc-5"}
{"ts":"ISO8601","manager":"ao-orchestrator","phase":"FIX","finding":"cold_prs","prs":[123,124],"bead":"bd-xyz","dispatched":true}
```

**Dedup rule**: Before dispatching a fix, check knowledge base for same `finding` + `detail` within last 2h. If found and bead exists, skip dispatch and note in log.

### 5. Safety & Guardrails

| Mechanism | Implementation |
|-----------|---------------|
| Autonomous scope cap | `evolveLoop.autonomousFixScopes` in config: only allow `config-edit`, `claw-dispatch`, `bead-create`; block `gh pr merge`, `gh pr close`, destructive git |
| Escalation triggers | 3 consecutive failed fix dispatches → escalate to bead + human notification |
| Anti-stall | Max 3 fix dispatches per evolve cycle; if all fail, record and defer |
| Kill switch | `evolveLoop.enabled: false` or `EVOLVE_LOOP_ENABLED=false` env var |
| No polling under load | If `gh api` core quota < 500, skip MEASURE phase |
| Context budget | Manager session captures max 20 tmux pane lines per worker; no full conversation capture |

### 6. Composio Contrast — Explicit

| Concern | Composio Orchestrator | Our Manager Evolve Loop |
|---------|----------------------|------------------------|
| Trigger model | Reactive only (webhook events) | Reactive + proactive (every poll cycle) |
| Self-assessment | None | OBSERVE→MEASURE→DIAGNOSE each cycle |
| Zero-touch tracking | None | Per-project rolling 24h rate |
| Friction detection | None | Auto-detects cold PRs, stuck workers, reaction failures |
| Improvement dispatch | Manual human action | Autonomous via `/claw` + `/antig` |
| Knowledge accumulation | None | Shared JSONL knowledge base across managers |
| CI model | lint + typecheck + test | lint + typecheck + test + skeptic (7-green) |

### 7. Integration Points

| Existing system | Integration |
|-----------------|-------------|
| `recovery/manager.ts` | Manager evolve loop supplements demand-driven recovery with proactive pattern detection. Does NOT replace it. |
| `lifecycle-manager.ts` | Both run in parallel. LM handles event routing; ME handles proactive assessment. |
| `orchestrator-prompt.ts` | Primary injection point. Adds evolve loop instructions to orchestrator prompt when `evolveLoop.enabled: true`. |
| `skeptic-cron.yml` | Skeptic runs independently. Manager evolve loop does not call skeptic directly — it dispatches fix workers that trigger skeptic via lifecycle reactions. |
| `bead tracker (br)` | Knowledge base dedup checks bead tracker. Manager creates/updates beads for systemic issues. |
| `zero-touch docs` | Manager MEASURE phase uses the same zero-touch definition from `docs/zero-touch-by-operator.md`. |
| `agentRules` | `autonomousFixScopes` in `evolveLoop` config limits what the manager can do autonomously. |
| `orchestratorRules` | Evolve loop instructions can be injected via `orchestratorRules` field for project-specific overrides. |

### 8. Configuration

In `agent-orchestrator.yaml`:

```yaml
projects:
  agent-orchestrator:
    evolveLoop:
      enabled: true
      pollCadence: lightweight   # lightweight = every LM poll; standard = every 10min
      autonomousFixScopes:
        - config-edit           # agentRules / reaction config changes
        - claw-dispatch         # ao spawn for fixes
        - bead-create           # create/update beads
        - antig-dispatch        # /antig when tmux cap hit
      knowledgeBasePath: ~/.ao-evolve-knowledge  # default
```

### 9. Anti-Stall Rules

1. **No GraphQL exhaustion**: Always use `gh api ... --method GET` REST calls; skip MEASURE if core quota < 500
2. **Tmux cap**: If active tmux sessions > 20, skip `/claw` dispatch; use `/antig` instead
3. **Stuck worker fast-path**: If worker output unchanged for 3+ poll cycles, kill + respawn without full diagnose phase
4. **Context budget**: Manager session must not capture full worker conversation — max 20 lines tmux pane per cycle
5. **Fix dispatch cap**: Max 3 fix dispatches per evolve cycle to prevent cascading failures
6. **Duplicate detection**: Always check knowledge base + bead tracker before dispatching

---

## Files to Change

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `EvolveLoopConfig` interface + `evolveLoop` field in `ProjectConfig` |
| `packages/core/src/config.ts` | Add `evolveLoop` to project config Zod schema |
| `packages/core/src/orchestrator-prompt.ts` | Add `generateEvolveLoopSection()` — injects evolve phases when `evolveLoop.enabled: true` |
| `docs/design/manager-evolve-loop-design.md` | This document |

---

## What This Design Does NOT Cover

- Implementation of the evolve loop phases (this is the design phase)
- Changes to `lifecycle-manager.ts` — polling loop architecture unchanged
- Skeptic integration — skeptic runs independently, triggered by reactions
- Testing strategy — spec'd separately after implementation plan
- Metrics dashboard — separate follow-on design if manager evolve loop proves effective
