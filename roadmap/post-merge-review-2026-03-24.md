# Post-Merge Review: 29 PRs in 3 Days (2026-03-24)

Triple-consultant review (Cursor, Gemini, Sonnet) of all PRs merged 2026-03-21 through 2026-03-24.

## Critical Findings

### P0 — pruneStaleWorktrees deletes ALL active worktrees (`bd-6ql`)
**PR #133** | `packages/core/src/session-manager.ts`

`pruneStaleWorktrees()` checks `tmux has-session -t ao-748` but real session names are `bb5e6b7f8db3-ao-748`. The check always fails → all AO worktrees treated as stale → deleted. Additionally, the `rmSync` fallback orphans `.git/worktrees/` entries (`bd-24k`), and the wrong repo may be used as `cwd` in multi-project configs.

**Status:** Worker `ao-751` dispatched on `feat/bd-6ql`.

## High Priority Findings

### P1 — Auto-kill on transient SCM failures destroys worktrees (`bd-6jc`)
**PR #127** | `packages/core/src/lifecycle-manager.ts`

When `agentDead=true` and SCM check throws (network error, rate limit), catch block falls through and returns `killed`, triggering worktree destruction via `sessionManager.kill()`. Transient failures become non-recoverable.

**Fix:** Consecutive-failure counter before returning killed, or restrict auto-kill to `merged` status only.

### P1 — Reactions fire on dead sessions before cleanup (`bd-5o1`)
**PR #120 reaction system** | lifecycle-worker

Killing a tmux session doesn't clean up AO session metadata. Lifecycle-worker keeps polling dead sessions, fires reactions (e.g. `changes-requested`), sends `ao send` to dead sessions, and notifies OpenClaw — which forwards to the operator terminal. Root cause: reaction evaluation runs before agentDead cleanup path.

**Fix:** Check session liveness before evaluating reactions.

## Medium Priority Findings

### P2 — encodeURIComponent breaks REST branch deletion (`bd-pjh`)
**PR #135** | `packages/plugins/scm-github/src/index.ts:1485`

`encodeURIComponent("feat/foo")` → `feat%2Ffoo` but GitHub refs API expects literal slashes. Branch deletion silently fails for any branch with `/` (most branches). Wrapped in try/catch so non-fatal.

**Status:** Worker `ao-749` dispatched.

### P2 — pr-green-check.py is a no-op burning 2 REST calls/prompt (`bd-soc`)
**PR #139** | `.claude/hooks/pr-green-check.py`

Hook always exits 0, outputs to stderr only. Burns 2 REST API calls per prompt without suppressing green-check behavior. Branch-name regex also extracts wrong number (session ID, not PR number).

**Status:** Worker `ao-750` dispatched.

### P2 — 30s polling interval risks GitHub secondary rate limits (`bd-fmv`)
**PR #120** | `packages/cli/src/commands/lifecycle-worker.ts`

10x increase from 300s to 30s. With 20 sessions, this risks abuse detection. Batch queries help but don't fully offset.

**Fix:** Adaptive interval (60-90s default, increase when rate limit headroom is low).

### P2 — Batch query reviewDecision normalization (`bd-o7t`)
**PR #118** | `packages/plugins/scm-github/src/index.ts`

Empty string `""` vs `null` for reviewDecision may normalize differently between batch and individual query paths. Potential merge gate bypass if `""` maps to `"none"` instead of `"pending"`.

### P2 — rmSync fallback orphans .git/worktrees entries (`bd-24k`)
**PR #133** | `packages/core/src/session-manager.ts`

After `git worktree remove` fails, `rmSync` deletes directory but leaves stale `.git/worktrees/<name>` entry. Given project ban on `git worktree prune`, creates permanently dirty state.

**Status:** Worker `ao-748` dispatched.

### P3 — pollCounters Map never cleaned in production (`bd-4pe`)
**PR #117** | `packages/core/src/review-backlog.ts`

Module-level Map grows by unique session IDs, never pruned. Bounded leak — low urgency.

## Already Fixed

| Issue | Fixed by | Notes |
|---|---|---|
| Token leaked in curl CLI args (PR #135) | PR #144 | ~8.5h exposure window; token now in 0600 temp file |

## Bead Summary

| Bead | Priority | Title | Worker |
|---|---|---|---|
| `bd-6ql` | P0 | pruneStaleWorktrees tmux name mismatch | `ao-751` |
| `bd-24k` | P2 | rmSync orphans .git/worktrees entries | `ao-748` |
| `bd-pjh` | P2 | encodeURIComponent breaks branch deletion | `ao-749` |
| `bd-soc` | P2 | pr-green-check.py no-op hook | `ao-750` |
| `bd-6jc` | P1 | auto-kill on transient SCM failures | — |
| `bd-5o1` | P1 | reactions fire on dead sessions | — |
| `bd-fmv` | P2 | 30s polling interval rate limit risk | — |
| `bd-o7t` | P2 | batch reviewDecision normalization | — |
| `bd-4pe` | P3 | pollCounters memory leak | — |

## Methodology

- 29 PRs reviewed (#111–#144, excluding closed #141)
- 3 independent reviewers: Cursor consultant, Gemini consultant, Sonnet code-review
- Cross-referenced findings; issues flagged by 2+ reviewers marked higher confidence
- All 3 reviewers independently flagged PR #133 `pruneStaleWorktrees` as the most critical issue
