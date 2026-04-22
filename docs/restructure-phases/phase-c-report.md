# Phase C — Plugin Extraction Audit Report

**Repository:** `jleechanorg/agent-orchestrator` (fork)
**Phase:** C — Plugin Extraction Feasibility
**Date:** 2026-04-21

## Executive Summary

This report evaluates fork-specific inline code in the upstream fork for extraction into new plugin packages. Three primary candidates exist across reaction handlers and lifecycle utilities, plus several inline utilities in the scm-github plugin. The **recommendation is MIXED**: some candidates are viable plugin extractions, while others should remain as fork code or be converted to configuration.

---

## 1. Plugin Extraction Candidates

### 1.1 Candidate: `request-merge` Reaction Handler

| Attribute | Value |
|-----------|-------|
| **Source** | `packages/core/src/fork-reaction-handlers.ts` (lines 39-100) |
| **Proposed Package** | `@jleechanorg/ao-reaction-request-merge` |
| **Current LOC** | ~62 LOC |
| **Plugin Slot** | New slot: `reaction` (or reuse existing) |

**What gets removed from core:**
- Import: `handleRequestMerge` from `./fork-reaction-handlers.js`
- Switch case at `lifecycle-manager.ts:1216`:
  ```typescript
  case "request-merge": {
    return handleRequestMerge(...);
  }
  ```

**Plugin Interface:**
```typescript
// In the reaction plugin slot:
interface ReactionModule {
  manifest: PluginManifest; // name, slot: "reaction", version
  create(config?: Record<string, unknown>): ReactionHandler;
}

interface ReactionHandler {
  handle(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    deps: ReactionHandlerDeps,
  ): Promise<ReactionResult>;
}

// ReactionHandlerDeps — injected at runtime:
interface ReactionHandlerDeps {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
  registry: PluginRegistry;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent: (type: EventType, opts: EventOpts) => OrchestratorEvent;
}
```

**Risk Assessment:**
| Risk | Severity | Mitigation |
|------|----------|------------|
| Lifecycle-manager coupling to reactionConfig types | Medium | Keep ReactionConfig in types.ts (shared) |
| Dep injection complexity | Low | Constructor receives deps object |
| Config schema changes | Low | Version the config interface |
| Breaking existing forks | Medium | Maintain backward import in fork-reaction-handlers.ts until all users migrate |

**Wiring in `agent-orchestrator.yaml`:**
```yaml
plugins:
  reaction-request-merge:
    enabled: true
    # Optional: mergeMethod: "squash" | "merge" | "rebase"
```

---

### 1.2 Candidate: `parallel-retry` Reaction Handler

| Attribute | Value |
|-----------|-------|
| **Source** | `packages/core/src/fork-reaction-handlers.ts` (lines 102-149) |
| **Proposed Package** | `@jleechanorg/ao-reaction-parallel-retry` |
| **Current LOC** | ~48 LOC |
| **Plugin Slot** | Same as above — `reaction` slot |

**What gets removed from core:**
- Import: `handleParallelRetry` from `./fork-reaction-handlers.js`
- Switch case at `lifecycle-manager.ts:1361`:
  ```typescript
  case "parallel-retry": {
    return handleParallelRetry(...);
  }
  ```

**Plugin Interface:**
Identical to `request-merge` — both fit the `ReactionHandler` interface. The `reactionConfig` contains `parallelRetry.strategies` and `parallelRetry.maxParallel`.

**Risk Assessment:** Same as 1.1 — low coupling to other fork code, depends on SessionManager which is injectable.

---

### 1.3 Candidate: `respawn-for-review` Reaction Handler

| Attribute | Value |
|-----------|-------|
| **Source** | `packages/core/src/fork-reaction-rfr.ts` (lines 87-282) |
| **Proposed Package** | `@jleechanorg/ao-reaction-respawn-for-review` |
| **Current LOC** | ~196 LOC |
| **Plugin Slot** | Same `reaction` slot |

**What gets removed from core:**
- Import: `handleRespawnForReview` from `./fork-reaction-rfr.js`
- Additional dep: `ProjectObserver` from `./observability.js`
- Switch case at `lifecycle-manager.ts:1404`:
  ```typescript
  case "respawn-for-review": {
    return handleRespawnForReview(...);
  }
  ```

**Plugin Interface:**
```typescript
interface RespawnForReviewDeps extends ReactionHandlerDeps {
  observer: ProjectObserver;
}
```

**Risk Assessment:**
| Risk | Severity | Notes |
|------|----------|-------|
| Additional dependency (ProjectObserver) | Medium | Observer must be injectable; this is already available in lifecycle-manager |
| Metadata mutation pattern | Low | Uses existing session metadata helpers |
| Escalation logic coupling | Low | self-contained in handler |

---

### 1.4 Candidate: Rate-Limit Lifecycle Detection

| Attribute | Value |
|-----------|-------|
| **Source** | `packages/core/src/fork-lifecycle-manager.ts` |
| **Proposed Package** | `@jleechanorg/ao-lifecycle-rate-limit` |
| **Current LOC** | ~238 LOC (entire file) |
| **Plugin Slot** | New slot: `lifecycle` (for poll-cycle hooks) |

**What gets removed from core:**
- Import: entire `fork-lifecycle-manager.js` module
- Call sites:
  - `lifecycle-manager.ts:53` — import statement
  - `lifecycle-manager.ts:631` — `await detectAndApplyRateLimitPause(...)`
  - `lifecycle-manager.ts:2596` — `clearProjectPause(...)`

**Extracted functions:**
1. `parseRateLimitReset(output: string)` — parses terminal output for rate-limit messages
2. `setProjectPause(configPath, project, sourceSessionId, until, isDurationBased)` — writes pause metadata
3. `clearProjectPause(configPath, project)` — clears pause metadata
4. `detectAndApplyRateLimitPause(...)` — poll-cycle hook combining 1-3

**Plugin Interface:**
```typescript
// Lifecycle slot — hooks into poll cycle
interface LifecycleModule {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): LifecycleHooks;
}

interface LifecycleHooks {
  // Called on each poll cycle
  onPoll?(session: Session, project: ProjectConfig, runtime: Runtime, sessionManager: SessionManager): Promise<void>;
  // Called on backlog sweep
  onBacklogSweep?(session: Session, project: ProjectConfig): Promise<void>;
}
```

**Risk Assessment:**
| Risk | Severity | Notes |
|------|----------|-------|
| Poll-cycle performance impact | High | Every poll adds one async call; must be fast/fail-fast |
| Metadata I/O coupling | Medium | Uses metadata.js helpers; ensure stable interface |
| Grace-window logic complexity | Low | Well-isolated in `detectAndApplyRateLimitPause` |

---

## 2. Per-Candidate Analysis

### 2.1 Could these become proper plugins in `packages/plugins/`?

**Answer: Yes, with the following path:**

1. **Create new packages:**
   ```
   packages/
     plugins/
       reaction-request-merge/
         package.json
         src/
           index.ts        # manifest + create()
           reaction-handler.ts
       reaction-parallel-retry/
       reaction-respawn-for-review/
       lifecycle-rate-limit/
   ```

2. **Register in `plugin-registry.ts`:**
   ```typescript
   { slot: "reaction", name: "request-merge", pkg: "@jleechanorg/ao-reaction-request-merge" },
   { slot: "reaction", name: "parallel-retry", ... },
   { slot: "reaction", name: "respawn-for-review", ... },
   { slot: "lifecycle", name: "rate-limit", ... },
   ```

3. **Add to PluginSlot type:**
   ```typescript
   type PluginSlot = "runtime" | "agent" | "workspace" | "tracker" | "scm" | "notifier" | "terminal" | "poller"
                     | "reaction" | "lifecycle";
   ```

### 2.2 Plugin Interface Definitions

**For reaction handlers:**
```typescript
export interface ReactionManifest {
  name: string;
  slot: "reaction";
  description: string;
  version: string;
  // Supported reaction keys
  reactsTo: string[]; // e.g., ["request-merge", "parallel-retry", "respawn-for-review"]
}

export interface ReactionModule {
  manifest: ReactionManifest;
  create(config?: Record<string, unknown>): ReactionHandler;
}

export interface ReactionHandler {
  handle(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    deps: ReactionHandlerDeps,
  ): Promise<ReactionResult>;
}
```

**For lifecycle hooks:**
```typescript
export interface LifecycleManifest {
  name: string;
  slot: "lifecycle";
  description: string;
  version: string;
}

export interface LifecycleModule {
  manifest: LifecycleManifest;
  create(config?: Record<string, unknown>): LifecycleHooks;
}

export interface LifecycleHooks {
  onPoll?(session: Session, project: ProjectConfig, runtime: Runtime, sessionManager: SessionManager): Promise<void>;
  onBacklogSweep?(session: Session, project: ProjectConfig): Promise<void>;
}
```

### 2.3 Wiring in `agent-orchestrator.yaml`

```yaml
plugins:
  # Reaction handlers (registered by reaction key in config)
  reaction-request-merge:
    enabled: true
    mergeMethod: squash  # optional override
  reaction-parallel-retry:
    enabled: true
    maxParallel: 3
  reaction-respawn-for-review:
    enabled: true
    escalateAfter: 3

  # Lifecycle hooks (auto-enabled when plugin loaded)
  lifecycle-rate-limit:
    enabled: true
```

### 2.4 What gets removed from `lifecycle-manager.ts`

| Current Import/Call | Removed? |
|---------------------|---------|
| `import { handleRequestMerge } from "./fork-reaction-handlers.js"` | Yes — new plugin registry |
| `import { handleRespawnForReview } from "./fork-reaction-rfr.js"` | Yes |
| `import { detectAndApplyRateLimitPause, clearProjectPause } from "./fork-lifecycle-manager.js"` | Yes |
| `case "request-merge": return handleRequestMerge(...)` | Yes — replaced with plugin lookup |
| `case "parallel-retry": return handleParallelRetry(...)` | Yes |
| `case "respawn-for-review": return handleRespawnForReview(...)` | Yes |
| `await detectAndApplyRateLimitPause(...)` in poll cycle | Yes — replaced with `lifecycle.onPoll()` |
| `clearProjectPause(...)` in backlog sweep | Yes — replaced with `lifecycle.onBacklogSweep()` |

**Estimated net removal:** ~15 lines of switch cases + imports, ~10 lines of poll-cycle calls.

---

## 3. scm-github Bucket B Items Analysis

### 3.1 Current Inline Utilities

| Utility | LOC | Purpose | Should become |
|---------|-----|--------|-------------|
| `DEFAULT_BOT_AUTHORS` | 8 | Bot author set for review filtering | Keep as config option |
| `buildBotAuthors(config)` | 7 | Merge config with DEFAULT_BOT_AUTHORS | Keep as helper in plugin |
| `deriveReviewDecisionGraphqlFromReviews()` | 25 | REST fallback for review decision | Keep as internal helper |
| `isRateLimitError(error)` | 10 | Error pattern detection | **Extract to shared utility** |
| `ghWithRetry(args, cwd?, maxRetries?, tokenEnv?)` | 38 | Rate-limit retry with REST fallback | **Extract to shared utility** |
| `fetchPrViewFallbackAsJson(args)` | 28 | REST API fallback | Keep as helper |

### 3.2 Recommendation: Keep as Plugin Config, Not Separate Plugins

**Rationale:**

These utilities are tightly coupled to scm-github's implementation. Separating them into distinct plugins would add:
- Additional plugin-slot pressure (need `scm-utils` slot)
- Version coupling risk (utilities change with SCM behavior)
- No clear复用 benefit (no other SCM plugin uses these exact utilities)

**Proposed approach:**

1. **`isRateLimitError()` and `ghWithRetry()` → extract to `@jleechanorg/ao-core-utils`**
   - These are generally useful for any plugin that calls external APIs
   - Single utility package consumed by multiple plugins
   - Low coupling to SCM-specific types

2. **Bot author filtering → scm-github config option**
   ```yaml
   plugins:
     scm-github:
       extraBotAuthors:
         - "custom-bot[bot]"
   ```

3. **REST fallback logic → internal to scm-github**
   - Keep `deriveReviewDecisionGraphqlFromReviews()` inline — it knows the exact REST/GraphQL schema
   - Already correctly isolates the fallback behavior

---

## 4. New Plugin Slot Analysis

### 4.1 Is a `reaction` slot warranted?

**Yes — for this fork's needs, a `reaction` slot enables:**

1. **Third-party reaction handlers** — other forks/users can contribute reaction behaviors
2. **Versioned interfaces** — clear `@since` / `@deprecated` for reactionConfig schemas
3. **Lazy loading** — reaction handlers are only needed when their reaction key triggers

**Counter-argument:** The number of reaction types is small (currently 3 fork-specific + upstream's). A slot may be over-engineering.

**Recommendation:** Create the slot. The interface is simple enough that it's not over-engineering, and this enables the broader fork community to contribute reactions.

### 4.2 Is a `lifecycle` slot warranted?

**Maybe — compare:**

| Option | Pros | Cons |
|--------|-----|-----|
| **Lifecycle slot** | Poll-cycle hooks are first-class; enables third-party lifecycle handlers; clear interface | Adds to slot list; lifecycle may be too generic |
| **Keep inline** | Simpler; fewer abstractions; fork-specific rate-limit is the only consumer | Poll-cycle behavior stays in core; harder to disable independently |

**Recommendation:** Create the slot. The rate-limit detector is a clear candidate, and the `onPoll`/`onBacklogSweep` interface is minimal enough to be justified.

### 4.3 Comparison: Keep reactions as inline fork code

| Factor | Inline (current) | Plugin slot (proposed) |
|--------|------------------|----------------------|
| LOC in lifecycle-manager | ~15 imports + switch cases | Registry lookup + handler dispatch |
| Enable/disable granularity | All or none | Per reaction in config |
| Third-party extensibility | Not possible | New plugins in `@jleechanorg/ao-reaction-*` |
| Testing | Fork-utils test | Each reaction has isolated test suite |
| Version coupling | Tight to lifecycle-manager | Versioned plugin interface |

**Recommendation:** Go with plugin slot. The migration cost is moderate (new packages + registry + types), but the extensibility benefit justifies it for a fork that is itself a platform.

---

## 5. Plugin Dependency Analysis

### 5.1 Reaction Handler Dependencies

```typescript
interface ReactionHandlerDeps {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
  registry: PluginRegistry;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent: (type: EventType, opts: EventOpts) => OrchestratorEvent;
}
```

### 5.2 Can these be passed as plugin constructor deps?

**Yes — the architecture already supports this:**

1. **Constructor injection pattern:**
   ```typescript
   // In plugin creation:
   export function create(config?: Record<string, unknown>): ReactionHandler {
     const deps = injectDeps(); // Resolves from context
     return new ReactionHandler(deps);
   }
   ```

2. **Current precedent:** Notifier plugins (e.g., discord) receive context implicitly via AoC context.

3. **Required addition:** The plugin registry must expose a `getContext()` method that provides:
   - `sessionManager`
   - `config`
   - `registry`
   - `notifyHuman`
   - `createEvent`

### 5.3 Does the architecture support this?

**Current gap:** The `PluginRegistry` interface (`types.ts`) does not expose a context getter. The current plugin creation only passes `config` (from `agent-orchestrator.yaml`).

**Required extension:**
```typescript
// In plugin-registry.ts, extend PluginRegistry interface:
interface PluginRegistry {
  // ... existing methods
  getContext(): PluginContext;
}

interface PluginContext {
  sessionManager: SessionManager;
  config: OrchestratorConfig;
  registry: PluginRegistry;
  notifyHuman: (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
  createEvent: (type: EventType, opts: EventOpts) => OrchestratorEvent;
}
```

**Risk:** This is a medium-sized change to the plugin loading lifecycle. It requires:
1. When plugins are instantiated (in `plugin-registry.ts`)
2. The AoC context must be available at instantiation time

---

## 6. Summary Table

| Candidate | Package | Slot | Plugin viable? | Risk | Recommendation |
|-----------|---------|------|----------------|------|---------------|
| `request-merge` | `@jleechanorg/ao-reaction-request-merge` | `reaction` | Yes | Low | **Extract** |
| `parallel-retry` | `@jleechanorg/ao-reaction-parallel-retry` | `reaction` | Yes | Low | **Extract** |
| `respawn-for-review` | `@jleechanorg/ao-reaction-respawn-for-review` | `reaction` | Yes | Medium | **Extract** |
| Rate-limit detection | `@jleechanorg/ao-lifecycle-rate-limit` | `lifecycle` | Yes | Medium | **Extract** |
| `isRateLimitError` | `@jleechanorg/ao-core-utils` | Utility | Yes | Low | **Extract to utils package** |
| Bot author filtering | scm-github config | n/a | n/a | N/A | Keep as config |
| REST fallback | scm-github internal | n/a | n/a | N/A | Keep inline |

---

## 7. Migration Path (if approved)

1. **Phase 1: New plugin types** (no behavioral change)
   - Add `reaction` and `lifecycle` to `PluginSlot` type
   - Register in plugin-registry.ts with empty BUILTIN_PLUGINS entries

2. **Phase 2: Extract utilities** (independent)
   - Extract `isRateLimitError` and `ghWithRetry` to `@jleechanorg/ao-core-utils`

3. **Phase 3: Create reaction packages** (one at a time)
   - Start with `request-merge` as simplest
   - Add to agent-orchestrator.yaml plugins section
   - Remove import + switch case from lifecycle-manager.ts

4. **Phase 4: Lifecycle package**
   - Extract fork-lifecycle-manager.ts to plugin
   - Replace poll-cycle call with `lifecycle.onPoll()`

5. **Phase 5: Deprecate inline fork handlers**
   - After all consumers migrate, remove fork-reaction-handlers.ts / fork-reaction-rfr.ts imports
   - Keep empty stub files for backward compatibility during deprecation window

---

## 8. Open Questions for User

1. **Should we create a separate `@jleechanorg/ao-core-utils` package, or keep rate-limit utilities in `@jleechanorg/ao-plugin-scm-github`?**
2. **Should the new `reaction` and `lifecycle` slots be created in this fork, or proposed upstream first?**
3. **Is there a timeline preference for this migration? (blocker for upstream sync, or can stay inline for now)**

---

*End of Phase C Report*