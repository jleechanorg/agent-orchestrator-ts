# Phase B: Config-Driven Behavior Audit Report

## Audit Summary

**Date:** 2026-04-22
**Branch:** test-conflicts
**Task:** Find hardcoded fork logic that CAN be expressed in agent-orchestrator.yaml (zero merge conflict with upstream)

## Files Audited
- `packages/core/src/lifecycle-manager.ts`
- `packages/core/src/session-manager.ts`
- `packages/core/src/fork-reaction-retry-policy.ts`
- `packages/core/src/fork-dead-agent.ts`
- `packages/core/src/fork-lifecycle-manager.ts`
- `packages/core/src/config.ts`
- `packages/core/src/types.ts`

## Config Schema Already Present (Partial)
- `SpawnQueueConfig.maxActiveSessions` — already config-driven in spawn-queue.ts
- `TaskQueueConfig.maxConcurrent` — already config-driven in task-queue.ts
- `defaults.evolveLoop` — already config-driven (bd-jhv1)

---

## Hardcoded Behaviors That Can Move to Config

### 1. SCM_FAILURE_THRESHOLD hardcoded to 3
**File:** `lifecycle-manager.ts:597`
**Current hardcoded logic:**
```typescript
const SCM_FAILURE_THRESHOLD = 3;
```
Used at lines 723, 891 — kills sessions with dead agents after 3 consecutive SCM failures.

**Proposed YAML config:**
```yaml
defaults:
  scmFailureThreshold: 3  # kills dead-agent sessions after N consecutive SCM failures

projects:
  my-project:
    scmFailureThreshold: 5  # per-project override
```
**Status:** PROOF-OF-CONCEPT IMPLEMENTED — config field added to DefaultPluginsSchema and ProjectConfigSchema in config.ts, types.ts, and lifecycle-manager.ts updated to use config lookup.

---

### 2. startupGracePeriodMs hardcoded default of 120000ms
**File:** `lifecycle-manager.ts:561, 619`
**Current hardcoded logic:**
```typescript
if (session.status === "spawning" && sessionAgeMs < (config.startupGracePeriodMs ?? 120_000)) {
  return { status: "spawning", agentDead: false };
}
```
The type `OrchestratorConfig.startupGracePeriodMs?: number` exists in types.ts, but no YAML config key — it can only be set programmatically.

**Proposed YAML config:**
```yaml
defaults:
  startupGracePeriodMs: 120000  # 2 minutes — skip liveness probes during agent init

projects:
  my-project:
    startupGracePeriodMs: 180000  # slower agents need more init time
```
**What would break:** None — type already exists, only needs YAML key added to DefaultPluginsSchema.

---

### 3. OpenCode agent session reuse hardcoded "opencode" name
**File:** `session-manager.ts:677, 1214, 1563, 1570`
**Current hardcoded logic:**
```typescript
// Line 677: hardcoded agent name filter
if (raw["agent"] !== "opencode") return false;

// Lines 1214, 1563, 1570: hardcoded agent name check
plugins.agent.name === "opencode"
```
**Proposed YAML config:**
```yaml
defaults:
  agentSessionReuseStrategy:
    opencode: reuse  # reuse | delete | ignore
    codex: ignore   # all other agents default to "ignore"
```
**What would break:** opencode-specific behavior would become configurable. Other agents (codex, claude) would gain session reuse controls.

---

### 4. send-to-agent retry cap hardcoded to 3
**File:** `fork-reaction-retry-policy.ts:38`
**Current hardcoded logic:**
```typescript
const defaultRetries = action === "send-to-agent" ? 3 : Infinity;
return reactionConfig.retries ?? defaultRetries;
```
Currently the default of 3 for send-to-agent is in fork-reaction-retry-policy.ts (a fork companion). The `retries` field exists in ReactionConfigSchema but the action-based default does not.

**Proposed YAML config:**
```yaml
defaults:
  reactionRetries:
    send-to-agent: 3
    notify: Infinity
    auto-merge: 0

reactions:
  ci-failed:
    retries: 5  # per-reaction override
```
**What would break:** None — currently in fork companion, making it config-driven is additive.

---

### 5. Rate-limit pause detection hardcoded pattern
**File:** `fork-lifecycle-manager.ts:165` — `detectAndApplyRateLimitPause`
**Current hardcoded logic:** Scans agent terminal output for rate-limit error patterns. Called unconditionally for every live-agent poll cycle.

**Proposed YAML config:**
```yaml
defaults:
  rateLimitPause:
    enabled: true
    graceWindowMs: 60000  # prevent re-pause loops

projects:
  my-project:
    rateLimitPause:
      enabled: false  # disable for specific projects
```
**What would break:** None — new config field with sensible default (enabled=true).

---

### 6. Dead agent override: send-to-agent reactions skipped for dead agents
**File:** `fork-dead-agent.ts:57`
**Current hardcoded logic:**
```typescript
if (preReactionCfg?.action !== "send-to-agent") return { effectiveStatus, newStatus };
```
This hardcodes that ONLY "send-to-agent" reactions are overridden (skipped) for dead agents. All other action types proceed.

**Proposed YAML config:**
```yaml
defaults:
  deadAgentOverride:
    skipActions: ["send-to-agent"]  # reactions to skip when agent is dead

reactions:
  ci-failed:
    skipWhenDead: true  # explicit per-reaction override
```
**What would break:** None — makes override behavior configurable without changing default behavior.

---

## Config-Driven vs. Hardcoded Comparison

| # | Behavior | Currently | Config Location Needed | Effort |
|---|---|---|---|---|
| 1 | SCM failure threshold | Hardcoded 3 | `defaults.scmFailureThreshold` + `projects[].scmFailureThreshold` | **DONE** |
| 2 | Startup grace period | Hardcoded 120s + type | `defaults.startupGracePeriodMs` | Low |
| 3 | OpenCode session reuse | Hardcoded "opencode" | `defaults.agentSessionReuseStrategy` | Medium |
| 4 | Send-to-agent retry cap | Hardcoded 3 in fork | `defaults.reactionRetries` | Low |
| 5 | Rate-limit pause | Fork companion | `defaults.rateLimitPause` | Low |
| 6 | Dead agent override | Hardcoded send-to-agent | `defaults.deadAgentOverride.skipActions` | Low |

---

## Proof-of-Concept: SCM Failure Threshold (COMPLETED)

### Summary
The hardcoded `SCM_FAILURE_THRESHOLD = 3` in `lifecycle-manager.ts` has been replaced with a config-driven lookup:

```typescript
// BEFORE (hardcoded):
const SCM_FAILURE_THRESHOLD = 3;

// AFTER (config-driven):
const SCM_FAILURE_THRESHOLD = project.scmFailureThreshold ?? config.defaults.scmFailureThreshold ?? 3;
```

### Files Changed

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Added `scmFailureThreshold?: number` to `DefaultPlugins` and `ProjectConfig` interfaces |
| `packages/core/src/config.ts` | Added `scmFailureThreshold: z.number().int().min(1).max(100).default(3).optional()` to `DefaultPluginsSchema`; added `scmFailureThreshold: z.number().int().min(1).max(100).optional()` to `ProjectConfigSchema` |
| `packages/core/src/lifecycle-manager.ts` | Replaced hardcoded constant with config lookup at line 598-599 |
| `packages/core/src/__tests__/phase-b-scm-failure-threshold.test.ts` | **New test file** — 3 tests verifying threshold behavior with config |

### YAML Usage
```yaml
defaults:
  scmFailureThreshold: 3  # global default

projects:
  my-app:
    scmFailureThreshold: 5  # override per-project
```

### Test Results
```
src/__tests__/phase-b-scm-failure-threshold.test.ts
  ✓ should kill session when scmFailureCount >= default threshold (3)
  ✓ should kill session when scmFailureCount=1 with no PR (bd-ara fallback)
  ✓ should use project override scmFailureThreshold=2 (session killed)
```

All existing tests pass (84/85 files, 1605/1608 tests). The 3 failing tests in `wholesome.test.ts` are pre-existing failures about `[agento]` commit prefix validation, unrelated to this change.

---

## Migration Path for Each Hardcoded Behavior

### Low Effort (just config key + schema, no logic change needed)
- **#2 startupGracePeriodMs**: Type already exists. Add YAML key to DefaultPluginsSchema.
- **#4 send-to-agent retry cap**: Default already in fork companion. Extract to config with same value.
- **#5 rate-limit pause**: Already a fork companion. Add config enable/disable with same default behavior.
- **#6 dead agent override**: Already in fork companion. Make skip list configurable.

### Medium Effort (requires logic refactor)
- **#3 OpenCode session reuse**: Multiple call sites with hardcoded `plugins.agent.name === "opencode"`. Needs a refactor to use a config map lookup instead.

### Done
- **#1 SCM failure threshold**: Proof-of-concept complete.
