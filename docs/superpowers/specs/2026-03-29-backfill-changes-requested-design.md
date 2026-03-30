# Design: Backfill CHANGES_REQUESTED PRs with Dead Workers

**Date:** 2026-03-29
**Status:** Draft
**Bead:** orch-bxf

---

## Background

When CR posts `CHANGES_REQUESTED` and the assigned AO worker is dead (tmux session gone, context exhausted, or process crashed), the PR becomes unattended. The lifecycle-manager has three overlapping mechanisms that almost handle this, but there's a gap:

1. **`changes-requested` reaction** — fires for sessions in the list with CR CHANGES_REQUESTED, injects review context via `buildReactionContext`, but **is skipped when agent is dead**
2. **`applyDeadAgentOverride`** (`fork-dead-agent.ts`) — overrides `"changes_requested"` → `"killed"` when agent is dead + reaction needs live agent, enabling session cleanup
3. **`backfillUncoveredPRs()`** — runs every 5 min, spawns for PRs with **no active session**; but sessions with `agentDead=true` are still in the session list, so they count as "covered" and never get backfilled

**The gap:** A dead-agent session stays in the list with a non-terminal PR, blocking backfill. When the session IS eventually cleaned up (via session-reaper or other means), backfill spawns a generic worker — without the CR review context that was the whole point.

This design closes the gap by augmenting `backfillUncoveredPRs()` with:
1. Tmux liveness check to exclude dead-agent sessions from the "covered" set
2. CR review comment fetching for CHANGES_REQUESTED PRs before spawning
3. A targeted spawn prompt with review context injected

---

## Goals

1. PRs with `reviewDecision=CHANGES_REQUESTED` and no live tmux session get a fresh worker within one backfill cycle
2. The spawned worker receives the specific CR review comments, not a generic "continue working" message
3. Rate-limiting prevents runaway spawning (max 2 respawns per cycle)
4. Non-CHANGES_REQUESTED PRs behave identically to before (no behavior change)

---

## Tenets

- **Minimal surface area** — augment existing backfill rather than adding a new top-level function
- **REST-only** — use GitHub REST API (`gh api`) for PR enumeration and review fetching; no GraphQL
- **Fail-open for non-tmux runtimes** — if `runtimeHandle` is null or tmux check fails, treat session as alive
- **Reuse existing infrastructure** — `buildReactionContext()` from `reaction-context.ts` is already used by `fork-reaction-rfr.ts`; reuse it

---

## Architecture

```text
pollAll()
  └─ backfillUncoveredPRs()  [backfill-extensions.ts]
       │
       ├─ scm.listOpenPRs()              [REST — already in place]
       ├─ sessionManager.list()           → activeSessions
       │
       ├─ Build coveredPRs + coveredBranches from activeSessions
       │   (filters TERMINAL_STATUSES — already in place)
       │
       ├─ NEW: tmux liveness pass
       │   For each session in activeSessions (non-terminal):
       │     If session.runtimeHandle is null → skip (non-tmux runtime)
       │     tmux.hasSession(session.runtimeHandle.id)
       │     If session is dead:
       │       Remove session.pr.number from coveredPRs
       │       Remove session.branch from coveredBranches
       │
       ├─ uncovered = openPRs − coveredPRs
       │
       ├─ NEW: for each uncovered PR where reviewDecision = CHANGES_REQUESTED:
       │     fetch CR reviews via scm.getReviews(pr)
       │     extract CR's CHANGES_REQUESTED comments
       │     build context message (reuse buildReactionContext or equivalent)
       │
       ├─ NEW: rate-limit
       │     Module-level counter, reset each backfill invocation
       │     Max 2 successful respawns for CHANGES_REQUESTED PRs per cycle
       │
       └─ spawn for first qualifying uncovered PR
            Prompt: PR context + CR review comments (not generic "continue working")
```

---

## Detailed Changes

### `backfill-extensions.ts`

**New imports:**
```typescript
import { hasSession } from "./tmux.js";
```

**New module-level state:**
```typescript
let changesRequestedRespawnCount = 0;
const MAX_CHANGES_REQUESTED_RESPAWNS_PER_CYCLE = 2;
```

**Tmux liveness pass** (after building `coveredPRs` / `coveredBranches`):
```typescript
// Prune dead-agent sessions from covered sets so they become "uncovered"
for (const session of activeSessions) {
  if (TERMINAL_STATUSES.has(session.status)) continue;
  if (!session.runtimeHandle) continue; // non-tmux runtime — skip
  const live = await hasSession(session.runtimeHandle.id).catch(() => true);
  if (!live) {
    if (session.pr?.number) coveredPRs.delete(session.pr.number);
    if (session.branch) coveredBranches.delete(session.branch);
  }
}
```

**CR context fetch** (for each uncovered PR with CHANGES_REQUESTED):
```typescript
// Fetch reviewDecision for each uncovered PR
const prReviewDecisions = await Promise.allSettled(
  uncovered.map(async (pr) => {
    const decision = await scm!.getReviewDecision(pr);
    return { pr, decision };
  })
);

// Separate CHANGES_REQUESTED from others
const crPRs = prReviewDecisions
  .filter((r): r is PromiseFulfilledResult<{pr: PRInfo; decision: string}> =>
    r.status === "fulfilled" && r.value.decision === "changes_requested"
  )
  .map(r => r.value.pr);

// For each CHANGES_REQUESTED PR, fetch CR review comments
const crContextMap = new Map<number, string>();
for (const pr of crPRs) {
  try {
    const reviews = await scm!.getReviews(pr);
    const crReview = reviews
      .filter(r => String(r.author ?? "").endsWith("coderabbitai[bot]"))
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
      .find(r => r.state === "changes_requested");

    if (crReview?.body) {
      crContextMap.set(pr.number, crReview.body);
    }
  } catch {
    // No CR reviews — proceed without context
  }
}
```

**Spawn with context**:
```typescript
// Prioritize CHANGES_REQUESTED PRs with context
const sortedUncovered = [
  ...crPRs.filter(pr => crContextMap.has(pr.number)),
  ...uncovered.filter(pr => !crContextMap.has(pr.number)),
];

for (const pr of sortedUncovered) {
  // Rate-limit CR respawns
  if (crContextMap.has(pr.number)) {
    if (changesRequestedRespawnCount >= MAX_CHANGES_REQUESTED_RESPAWNS_PER_CYCLE) continue;
    changesRequestedRespawnCount++;
  }

  const context = crContextMap.get(pr.number);
  let prompt: string;
  if (context) {
    prompt = `CodeRabbit posted CHANGES_REQUESTED on PR #${pr.number} (${pr.url}).
The review comments are:
---
${context}
---
Fix exactly these items, commit with [agento], and push.`;
  } else {
    // Fallback — same as current behavior
    prompt = `Continue working on PR #${pr.number}: [PR title: "${escapedTitle}"]...`;
  }

  // spawn + claim (same as existing)
  const session = await sessionManager.spawn({ projectId, prompt });
  await sessionManager.claimPR(session.id, String(pr.number));
  return true;
}
```

**Reset counter at top of function**:
```typescript
changesRequestedRespawnCount = 0;
```

### Error handling

| Scenario | Behavior |
|----------|----------|
| `tmux.hasSession()` throws | Treat as "alive" (fail-open) |
| `scm.getReviews()` fails | Skip context, use generic prompt |
| `scm.getReviewDecision()` fails | Treat as non-CHANGES_REQUESTED (fail-open) |
| Spawn fails | Existing backfill retry logic handles it |
| Rate-limit hit | Log and skip; next cycle handles it |

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/backfill-extensions.ts` | Add tmux liveness pass, CR context fetch, rate-limit, context-aware spawn prompt |

---

## Testing

1. **Unit test**: `backfill-extensions.ts` — mock `scm.listOpenPRs`, `scm.getReviewDecision`, `scm.getReviews`, `tmux.hasSession`, `sessionManager.spawn`, `sessionManager.claimPR`
   - Dead tmux session → PR becomes uncovered
   - Alive tmux session → PR stays covered
   - CHANGES_REQUESTED PR with CR context → prompt contains review body
   - CHANGES_REQUESTED PR with no CR context → generic prompt
   - Rate-limit (2) → third CR-PR skipped

2. **Integration test**: Full backfill run with real `gh api` calls (REST only)
   - Verify CR context is fetched and injected into spawn prompt

---

## Verification

- `pnpm --filter @jleechanorg/ao-core test` passes
- Manual: kill a tmux session for a CHANGES_REQUESTED PR, verify backfill spawns within 5 min with CR context
