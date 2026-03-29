# orch-nk7: Productivity-Based Stall Detection

**Author:** ao session feat/orch-nk7
**Date:** 2026-03-29
**Status:** Implemented
**Revision:** 2026-03-29 — addressed CR code-fence labels, integration snippet, REST API table

## Background

The lifecycle-manager (`packages/core/src/lifecycle-manager.ts`) polls active sessions on a configurable interval and checks agent liveness via:
- Runtime `isAlive()` probe
- Agent `getActivityState()` (JSONL-based)
- `stuck-worker-detector.ts` pane analysis (after 3 idle cycles)

These detect that the **agent is alive**, but not that it is **making progress**. Workers can exhaust context, stall waiting for CR reviews, or lose task context — sitting idle indefinitely with no automated detection or recovery.

## Goals

1. **Merged-PR cleanup** — detect when a session's PR is merged/closed and kill the session + clean up the worktree
2. **Stall detection** — detect when a branch has had no new commits for >30 min and PR is not green; nudge with specific state
3. **Context exhaustion** — detect when tmux pane shows <5% context remaining ("N% until auto-compact"); nudge to summarize and continue

## Non-Goals

- Replace `stuck-worker-detector.ts` — that handles tmux-level pane signals (shell prompt, permission prompts)
- Replace the main poll cycle — productivity checks run on a separate 15-minute interval
- GraphQL API calls — all PR checks use REST (avoids rate limit exhaustion)

## Architecture

```text
lifecycle-manager.ts
  └── startProductivityChecking()  ← new setInterval every 15 min
        └── runProductivityChecks(sessions: Session[])
              ├── checkMergedPRCleanup()     → kill + worktree cleanup
              ├── checkStallDetection()      → send nudge with PR state
              └── checkContextExhaustion()   → send nudge to summarize
```

## File Changes

### New: `packages/core/src/productivity-checker.ts`

```typescript
// Public API

/**
 * Run all productivity checks for a list of sessions.
 * Called every 15 minutes by lifecycle-manager.
 */
export async function runProductivityChecks(
  sessions: Session[],
  deps: ProductivityDeps,
): Promise<ProductivityResult>

/**
 * Check if session's PR is merged or closed.
 * Uses REST API — no GraphQL.
 * Returns 'killed' if PR was merged/closed and session was killed.
 */
export async function checkMergedPRCleanup(
  session: Session,
  deps: ProductivityDeps,
): Promise<'killed' | 'skipped'>

/**
 * Check if session's branch has had no new commits for >30 min
 * and PR is not green. If so, send a targeted nudge.
 * Uses REST API for commit date.
 */
export async function checkStallDetection(
  session: Session,
  deps: ProductivityDeps,
): Promise<'nudged' | 'none'>

/**
 * Check tmux pane for "N% until auto-compact" pattern.
 * If <5% remaining, send nudge to summarize and continue.
 */
export async function checkContextExhaustion(
  session: Session,
  deps: ProductivityDeps,
): Promise<'nudged' | 'none'>
```

### Interface: `ProductivityDeps`

```typescript
export interface GhRestFn {
  (owner: string, repo: string, path: string): Promise<unknown>;
}

export interface ProductivityDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  sendKeys: (sessionName: string, text: string) => Promise<void>;
  capturePane: (sessionName: string, lines?: number) => Promise<string>;
  killSession: (sessionName: string) => Promise<void>;
  ghRest?: GhRestFn; // optional; defaults to internal ghRest helper
}
```

**Cooldown state** is kept internal to the checker via a module-level `Map<string, number>` (`"sessionId:nudgeType" → timestamp`). No `getLastNudgeAt`/`setLastNudgeAt` callbacks needed — nudge deduplication is encapsulated within the module.

### Nudge messages

**Stall detection nudge:**
```text
PR #N has had no new commits for >30 min and is not green.
CI: <status>
CR state: <approved/changes_requested/pending>
URL: https://github.com/<owner>/<repo>/pull/<number>
Continue working on this PR or explain the blocker.
```

**Context exhaustion nudge:**
```text
Context is <N>% remaining. Summarize progress so far and continue working.
Do not repeat work already done.
```

**Nudge deduplication:** Track last nudge timestamp per session. Do not send the same nudge type twice within 60 minutes.

### Integration into `lifecycle-manager.ts`

```typescript
const PRODUCTIVITY_INTERVAL_MS = 15 * 60_000;

function startProductivityChecking(): void {
  if (productivityTimer) return;
  productivityTimer = setInterval(() => void runProductivityCycle(), PRODUCTIVITY_INTERVAL_MS);
  productivityTimer.unref();
  // Run immediately on start
  void runProductivityCycle();
}

async function runProductivityCycle(): Promise<void> {
  if (productivityRunning) return; // re-entrancy guard
  productivityRunning = true;
  try {
    const sessions = await sessionManager.list(scopedProjectId);
    const active = sessions.filter(s => !TERMINAL_STATUSES.has(s.status));
    await runProductivityChecks(active, { ...deps, ...tmuxHelpers });
  } catch (err) {
    // non-fatal — productivity check failure should not crash the main loop
    console.warn("[lifecycle-manager] productivity check failed:", err);
  } finally {
    productivityRunning = false;
  }
}
```

### REST API calls

| Check | Endpoint | Field used |
|---|---|---|
| PR merged/closed | `GET /repos/{o}/{r}/pulls/{n}` | `state`, `merged` |
| Last commit date | `GET /repos/{o}/{r}/commits/{sha}` (where `sha` is from PR metadata `head.sha`) | `commit.committer.date` |
| CI status | `GET /repos/{o}/{r}/commits/{sha}/check-runs?per_page=100` (primary; GitHub Actions) + `GET /repos/{o}/{r}/commits/{sha}/status` (fallback; external CI) | `check_runs[].conclusion`, `state` |
| CR state | `GET /repos/{o}/{r}/pulls/{n}/reviews` | Filter to `coderabbitai[bot]`, last review `state` |

## Testing Strategy

Unit tests in `packages/core/src/__tests__/productivity-checker.test.ts`:
- `checkMergedPRCleanup`: mock REST → merged returns killed, open returns skipped
- `checkStallDetection`: mock REST → old commit + not-green returns nudged, recent commit returns none
- `checkContextExhaustion`: mock tmux pane → "3% until" returns nudged, "80%" returns none
- Nudge deduplication: second nudge within 60 min returns none

Mock strategy: inject fake REST responses via `ProductivityDeps.ghRest` — no real GitHub API calls.

## Configuration

No new config fields required. Defaults:
- Productivity interval: 15 minutes (hardcoded constant)
- Stall threshold: 30 minutes (hardcoded constant)
- Context exhaustion threshold: 5% (parsed from tmux output)
- Nudge cooldown: 60 minutes per nudge type per session (in-memory Map)
