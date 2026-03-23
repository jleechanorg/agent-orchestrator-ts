# GH API Call Reduction — Runtime Validation v3

**Date:** 2026-03-22
**PR:** https://github.com/jleechanorg/agent-orchestrator/pull/110
**Branch:** `docs/gh-api-validation-report`
**Beads:** bd-q3x (GhCache), bd-fy7 (GraphQL executor), bd-ggf (beads tracker)

## v2 Results Summary (baseline)

- Fork used **165 calls/cycle** vs upstream **133 calls/cycle** (+24.1%)
- Workload: ~17 killed sessions — wrong workload, no GhCache exercise
- Evidence review: WARN (N=1, empty logs, hourly claim was projection)
- Poll interval difference confirmed: upstream=30s, fork=5min

## v3 Plan — Real PRs in mctrl_test

### Target PRs (jleechanorg/mctrl_test)

| PR | CI checks | Reviews | Branch |
|---|---|---|---|
| #172 | 6 | 2 | feat/lc1192-critical-connections |
| #168 | 6 | 3 | session/mt-65 |
| #158 | 6 | 2 | feat/lc84-largest-rectangle-histogram |

### Session layout: 2 sessions per PR (6 total)

Key design: GhCache deduplicates when multiple sessions check the same PR.

Per session, `checkSession` makes 4 SCM calls (lifecycle-manager.ts:330-370):
1. `scm.getPRState(session.pr)`
2. `scm.getCISummary(session.pr)`
3. `scm.getReviewDecision(session.pr)`
4. `scm.getMergeability(session.pr)` (conditional)

With 2 sessions per PR and 15s cache TTL (sequential polling):
- Session A: 4 API calls (cache miss)
- Session B: 4 cache hits (same PR, within TTL)
- Expected fork savings: ~12 calls/cycle (4 x 3 deduplicated sessions)
- Expected upstream: 24 calls (no cache)

### Session files: no runtimeHandle

Sessions created WITHOUT runtimeHandle field. This skips the tmux liveness
check (lifecycle-manager.ts:249: `if (session.runtimeHandle)`) and proceeds
directly to PR status checks. No agent contamination.

### Measurement: N=3 per variant, alternating

For each run: reset sessions to working, capture rate-limit before/after,
run lifecycle-worker with `--interval-ms 999999`, wait for poll, kill.

Fork runs also dump `getGhCache().metrics` and use `NODE_DEBUG=http`.

### Required artifacts

```
/tmp/ao-validation-v3/
  provenance/{upstream,fork}.json
  upstream/run-{1,2,3}/{rate-limit-before,rate-limit-after}.json, lifecycle.log
  fork/run-{1,2,3}/{rate-limit-before,rate-limit-after}.json, lifecycle.log, cache-metrics.json
  comparison-report.md
```

## v3 Results

*(to be filled after execution)*
