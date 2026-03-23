# GH API Call Reduction — Runtime Validation

**Date:** 2026-03-22/23
**PR:** https://github.com/jleechanorg/agent-orchestrator/pull/110
**Branch:** `docs/gh-api-validation-report`
**Beads:** bd-q3x (GhCache), bd-fy7 (GraphQL executor), bd-ggf (beads tracker)

## Executive Summary

Two runtime validation rounds (v2 and v3) consistently show the fork uses
**~1.6-1.8x MORE API calls per lifecycle poll cycle** than upstream, but achieves
an **~82% reduction in hourly API consumption** via a 10x longer poll interval
(300s vs 30s).

GhCache IS in the lifecycle-worker code path (confirmed via code trace:
`scm.getPRState()` → `gh()` → `ghWithRetry()` → `GhCache`), but the additional
fork features (merge gate, beads tracker, session visibility, resilient executor)
add more calls than the cache saves.

## v2: Killed-session baseline (2026-03-22)

| Metric | Upstream | Fork |
|---|---|---|
| Sessions | ~17 killed | ~17 killed |
| Core (REST) | 12 | 17 |
| GraphQL | 121 | 148 |
| **Total/cycle** | **133** | **165 (+24%)** |
| Evidence verdict | WARN (N=1, wrong workload) | |

## v3: Real PRs in mctrl_test (2026-03-23)

### Test setup

- 6 sessions (2 per PR), no runtimeHandle (skip tmux check)
- Target: jleechanorg/mctrl_test PRs #172, #168, #158 (each with 6 CI checks, 2-3 reviews)
- N=3 per variant
- All other lifecycle workers killed, launchd agents unloaded

### Per-run results

| Run | Upstream | Fork | Notes |
|---|---|---|---|
| 1 | 95 | 177 | Clean |
| 2 | 97 | 178 | Clean |
| 3 | 132 | 424 | Fork contaminated by auto-spawned orchestrator |
| trace | — | 228 | Clean re-run after killing orchestrator |

### Aggregate (clean runs only)

| | Upstream (N=3) | Fork (N=3, excl run 3) |
|---|---|---|
| Mean | 108 | 194 |
| Min | 95 | 177 |
| Max | 132 | 228 |

### Hourly projection (arithmetic, not measured)

| | Upstream | Fork |
|---|---|---|
| Poll interval | 30s | 300s (5min) |
| Cycles/hour | 120 | 12 |
| Calls/hour | ~12,960 | ~2,328 |
| **Reduction** | — | **~82%** |

## GhCache Analysis

### Code path (verified)

```
lifecycle-manager: checkSession()
  → scm.getPRState(pr)     → gh() → ghWithRetry() → GhCache → execCli("gh", ...)
  → scm.getCISummary(pr)   → gh() → ghWithRetry() → GhCache → execCli("gh", ...)
  → scm.getReviewDecision() → gh() → ghWithRetry() → GhCache → execCli("gh", ...)
  → scm.getMergeability()  → gh() → ghWithRetry() → GhCache → execCli("gh", ...)
```

GhCache IS in the lifecycle-worker path. The long-runner agent incorrectly
claimed it wasn't (saying "lifecycle manager uses Octokit directly") — this
was wrong. The scm-github plugin uses `gh` CLI calls routed through `ghWithRetry()`.

### Why cache didn't help enough

With 2 sessions per PR (6 sessions, 3 unique PRs):
- Session A for PR#172: 4 calls (cache miss)
- Session B for PR#172: should get 4 cache hits (within 15s TTL)
- Expected savings: ~12 calls (4 x 3 deduplicated sessions)

But the fork's additional features add ~86 extra calls per cycle (194 - 108 = 86).
Even if the cache saved 12 calls, the net effect is still +74 more calls than upstream.

Additional fork features that make extra API calls:
1. Merge gate — comprehensive check including mergeable state, conflict detection
2. Beads tracker — may query GitHub for issue/PR metadata
3. Session visibility safeguards — additional PR state verification
4. Resilient GraphQL executor — retries on failure (counts as additional calls)
5. Auto-orchestrator session — fork creates orchestrator tmux session per project

## Claim Assessment

| Claim | Verdict | Evidence |
|---|---|---|
| Fork uses fewer API calls **per cycle** | **NOT SUPPORTED** | v2: 165 vs 133 (+24%); v3: 194 vs 108 (+80%) |
| Fork uses fewer API calls **per hour** | **SUPPORTED** (arithmetic) | 10x longer interval = ~82% fewer calls/hr |
| GhCache deduplicates within-cycle calls | **LIKELY** but not directly measured | Cache is in code path; couldn't extract runtime metrics |
| Poll interval change is the primary savings | **CONFIRMED** | 30s → 300s default, verified in both codebases |

## Evidence Artifacts

```
/tmp/ao-validation-v2/   — v2 evidence (killed sessions, N=1)
/tmp/ao-validation-v3/   — v3 evidence (real PRs, N=3)
  provenance/{upstream,fork}.json
  upstream/run-{1,2,3}/{rate-limit-before,rate-limit-after}.json, lifecycle.log
  fork/run-{1,2,3}/{rate-limit-before,rate-limit-after}.json, lifecycle.log
  comparison-report.md
  results-summary.txt
```

## Measurement Issues Encountered

1. **Launchd auto-respawn**: 9 launchd agents auto-respawned lifecycle workers during test, consuming API budget. Had to unload all of them.
2. **Fork auto-orchestrator**: Fork creates orchestrator tmux session per project, which independently makes API calls (contaminated fork run 3).
3. **NODE_DEBUG=http**: Incompatible with ESM modules — no per-endpoint HTTP breakdown possible.
4. **Session mutation**: Lifecycle worker removes `pr=` field and adds `prAutoDetect=off` to sessions without runtimeHandle, requiring session reset between runs.

## bd-8y9: Deep Code Analysis — Per-Cycle Call Attribution

Code trace reveals fork and upstream make the **same structural calls** per session.
Fork actually makes fewer (6 gh invocations vs 8) due to GhCache. The 86-call gap
is environmental (retries, REST fallbacks, auto-orchestrator).

### Reduction opportunities implemented (Phase 1)

| # | Bead | Optimization | Status |
|---|---|---|---|
| 1 | bd-wg5 | Skip getMergeability when CI not passing | Done |
| 2 | bd-91z | Increase GhCache TTL 15s → 60s | Done |
| 3 | bd-4nz | Config flag to skip getAutomatedComments | Done |
| 4 | bd-sm7 | Combine getPRState + getReviewDecision | Planned (Phase 2) |
| 5 | bd-yjo | Throttle review backlog to every Nth poll | Planned (Phase 2) |
| 6 | bd-att | Batch GraphQL query for all PR checks | Planned (Phase 3) |

## Conclusions

The fork's API reduction strategy is **"poll less often" (10x interval)**, not
**"make fewer calls per poll" (which is actually worse)**. The per-cycle increase
from additional features is more than offset by the 10x reduction in poll frequency.

This is architecturally sound — the fork trades per-cycle overhead for better
behavior under rate-limit pressure (pause state, fail-closed, retry with backoff).
The poll interval change alone provides ~82% hourly reduction.

Phase 1 quick wins skip unnecessary API calls when CI is not green and increase
cache effectiveness. Phase 2-3 will further reduce calls through query combining
and batching.
