# Phase D: Upstream Contribution Candidates

## Summary

Four fork-extracted modules assessed for upstream PR viability.

---

## 1. `fork-reaction-retry-policy.ts` (39 LOC) — RECOMMENDED FIRST

### What it does
`resolveReactionMaxRetries(action, reactionConfig, isPeriodic)` returns a retry cap:
- `send-to-agent` → 3 (non-idempotent, bounded duplicate-delivery risk)
- All other actions → Infinity
- `isPeriodic=true` → Infinity (cooldown timer handles bounding)

### Upstream-compatible? YES
- No fork-specific imports. Pure function on primitive types.
- `ReactionRetryConfig` interface is self-contained (single `retries?` field).
- No config schema required — upstream would add this to existing reaction engine.

### Imports to strip
None. Zero fork imports.

### Target upstream file
`lifecycle-manager.ts` or a new `reaction-policy.ts` in `packages/core/src/`.

### Upstream PR draft
```
feat(lifecycle): cap send-to-agent retries at 3

send-to-agent is non-idempotent — each invocation delivers a message
to the agent's tmux session. Cap retries at 3 to bound duplicate
deliveries from edge cases (handler crash, process restart replays
same poll cycle). Periodic invocations remain uncapped since their
own cooldown timer provides bounding.

Closes: [fork issue]
```

---

## 2. `fork-utils.ts` (36 LOC) — RECOMMENDED SECOND

### What it does
`updateSessionMetadataHelper(session, updates, config)` — writes session metadata to disk via `updateMetadata` and cleans in-memory `session.metadata` dict (removes empty-string updates).

Used by lifecycle-manager and review-backlog.

### Upstream-compatible? YES
- All imports (`./types.js`, `./metadata.js`, `./paths.js`) are upstream core.
- No fork-specific deps whatsoever.
- Self-contained utility.

### Imports to strip
None.

### Target upstream file
`packages/core/src/metadata.ts` or a new `session-utils.ts` in `packages/core/src/`.

### Upstream PR draft
```
feat(core): add session metadata update helper

Consolidates the pattern of writing session metadata to disk and
cleaning empty-string in-memory updates. Used by lifecycle-manager
and review-backlog to avoid duplicating the update+clean logic.
```

---

## 3. `fork-skeptic-extension.ts` (67 LOC) — RECOMMENDED THIRD

### What it does
`runSkepticReviewReaction(params)` — executes skeptic evaluation as a reaction. Takes `reactionConfig.skepticModel`, `skepticPostComment`, `skepticExcludePaths` and calls `runSkepticReview(session, {...})`.

Distinguishes "all-files-excluded SKIPPED" (blocking=false) from "all-models-failed SKIPPED" (infra failure, should surface as failure).

### Upstream-compatible? PARTIALLY
- Core imports (`./types.js`, `./skeptic-reviewer.js`) are upstream.
- BUT: reads `reactionConfig.skepticModel`, `skepticPostComment`, `skepticExcludePaths` — these config fields exist in fork `agent-orchestrator.yaml` but not upstream.

### Imports to strip
None (all imports are upstream paths). However, the **config field names** (`skepticModel`, `skepticPostComment`, `skepticExcludePaths`) are fork extensions to the reaction config schema.

### Target upstream file
`lifecycle-manager.ts` skeptic-review case block (where this was extracted from).

### Upstream PR draft
```
feat(lifecycle): extract skeptic-review reaction to companion module

Moves skeptic-review reaction logic to fork-skeptic-extension.ts,
keeping lifecycle-manager.ts thin. Skeptic model, post-comment, and
exclude-paths are now configurable per reaction.

Note: upstream would need to add skepticModel/skepticPostComment/
skepticExcludePaths to ReactionConfig type.
```

---

## 4. `fork-dead-agent.ts` (63 LOC) — DEFER

### What it does
`applyDeadAgentOverride(...)` — when agent is dead and a pending reaction requires a live agent (`action === "send-to-agent"`), override effective+new status to `"killed"` so the session gets terminal cleanup instead of polling forever in a non-terminal state.

### Upstream-compatible? NO — design mismatch
- Core concept is universal (dead-agent cleanup is not fork-specific).
- BUT the implementation is tightly coupled to fork-specific `DeadAgentOverrideDeps` interface that expects `getReactionConfigForSession` as a dependency.
- The function requires access to pre-reaction event/transition lookup — this is lifecycle-manager internal state not exposed through any upstream interface.
- The `action === "send-to-agent"` check is fork-specific: upstream may not have this action name.

### Imports that would need stripping
```typescript
// DeadAgentOverrideDeps interface — entirely fork-specific:
statusToEventType, eventToReactionKey, getReactionConfigForSession
// These are lifecycle-manager internals not available upstream
```

### Target upstream file
Would need upstream refactor first to expose a clean `getReactionConfigForSession` API. Not a standalone cherry-pick.

---

## Recommended Order

| Priority | File | LOC | Upstream-clean? | Blocker |
|----------|------|-----|-----------------|---------|
| 1 | `fork-reaction-retry-policy.ts` | 39 | YES | None |
| 2 | `fork-utils.ts` | 36 | YES | None |
| 3 | `fork-skeptic-extension.ts` | 67 | PARTIAL | Config field names are fork-specific — upstream needs schema compat |
| 4 | `fork-dead-agent.ts` | 63 | NO | Lifecycle-manager internal deps; action name diff |

**Files 1 and 2 are zero-conflict upstream PRs.** File 3 needs an upstream config schema discussion first. File 4 needs a deeper upstream refactor before it can be extracted.

---

## Import Audit Summary

| File | Total imports | Fork-specific imports | Must strip |
|------|--------------|----------------------|------------|
| `fork-reaction-retry-policy.ts` | 0 | 0 | — |
| `fork-utils.ts` | 3 | 0 | — |
| `fork-skeptic-extension.ts` | 2 | 0 | Config field names (not imports) |
| `fork-dead-agent.ts` | 1 (types.js) | 0 (but DI interface is fork-internal) | DeadAgentOverrideDeps interface + action name |

Files 1 and 2 are genuinely upstream-ready as-is.
