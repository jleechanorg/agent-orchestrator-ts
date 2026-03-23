# GH API Call Reduction — Runtime Validation Report

## Date
2026-03-22T23:18Z

## Provenance

| | Upstream | Fork |
|---|---|---|
| Repo | ComposioHQ/agent-orchestrator | jleechanorg/agent-orchestrator |
| SHA | a37a210977561f50138e3104b9c5c880bff18198 | 6e1f6ade993270a06fd5ca6520145a0cb4d89daa |
| Branch | main | main |
| Poll interval default | 30,000ms (30s) | 300,000ms (5min) |

## Test Configuration

- Config: `~/.openclaw/agent-orchestrator.yaml` (shared between both)
- Namespace: `bb5e6b7f8db3-agent-orchestrator`
- Sessions: ~17 killed sessions in namespace
- Method: `npx ao lifecycle-worker agent-orchestrator --interval-ms 999999`
- Each worker ran for up to 120 seconds before being killed
- Rate limits captured via `gh api rate_limit` before and after each run

## Raw Rate-Limit Data

### Upstream (ComposioHQ)

| Metric | Before | After | Raw Delta |
|---|---|---|---|
| core.remaining | 4658 | 4644 | 14 |
| graphql.remaining | 4686 | 4565 | 121 |

### Fork (jleechanorg)

| Metric | Before | After | Raw Delta |
|---|---|---|---|
| core.remaining | 4643 | 4624 | 19 |
| graphql.remaining | 4551 | 4403 | 148 |

## Adjusted Deltas

Each run includes 2 `gh api rate_limit` calls (before + after) that are not part of the lifecycle-worker's consumption. Subtract 2 from each core delta.

| Metric | Upstream (adjusted) | Fork (adjusted) |
|---|---|---|
| Core (REST) | 12 | 17 |
| GraphQL | 121 | 148 |
| **Total** | **133** | **165** |

## Per-Cycle Analysis

**The fork used MORE API calls per cycle than upstream: 165 vs 133 (+24.1%).**

This is the opposite of what the "per-cycle efficiency" claim would predict. Possible explanations:

1. **Fork has additional features** that make extra API calls (beads tracker, MCP mail, pause-state checks, GraphQL executor with retry logic)
2. **GhCache deduplication** only helps when the same API call is made multiple times within a cycle -- with ~17 killed sessions, each session may need unique API calls (different branch, different PR)
3. **Fork's sequential session processing** (for-loop) vs upstream's concurrent (`Promise.allSettled`) does not reduce call count -- it only changes timing

## Poll Interval Analysis (Primary Savings Mechanism)

The fork's primary API savings is NOT per-cycle efficiency but reduced poll frequency:

| | Upstream | Fork | Reduction |
|---|---|---|---|
| Poll interval | 30s | 5min (300s) | 10x fewer cycles |
| Calls per cycle | 133 | 165 | -24.1% (more) |
| Calls per hour | 133 * 120 = 15,960 | 165 * 12 = 1,980 | **87.6% reduction** |

Even though the fork uses more calls per cycle, the 10x reduction in poll frequency yields an estimated **87.6% reduction in hourly API consumption**.

## Cache Hit Analysis

The fork's GhCache produced no debug log output during the run. The `DEBUG=gh-cache` environment variable did not produce visible cache hit/miss logging in the lifecycle-cycle.log. This means either:
- GhCache is not being invoked in the lifecycle-worker code path
- The DEBUG namespace does not match the cache module's debug logger
- Cache hits occurred but were not logged to stdout/stderr

## Conclusion

1. **Per-cycle claim ("fork uses fewer API calls per cycle") is NOT supported.** The fork used 165 calls vs upstream's 133 calls -- 24% MORE per cycle.

2. **Hourly/daily reduction claim IS supported**, purely through the poll interval change (30s -> 5min), yielding an estimated 87.6% reduction in API calls per hour.

3. **The GhCache deduplication benefit was not observable** in this test. No cache hit logs were produced, and the fork's higher per-cycle count suggests the cache may not be effectively reducing calls for this workload (killed sessions with unique branches/PRs).

4. **Both workers produced minimal/no log output**, making it impossible to trace individual API calls. The rate-limit delta is the only reliable measurement.

## Caveats

- Both workers processed the same ~17 killed sessions
- The upstream worker exited after one cycle (exitCode 0); the fork worker ran for 120s without producing output
- Time between upstream-after and fork-before captures was <1 minute, so natural rate-limit recovery is negligible
- The fork has additional features (beads, MCP mail, pause-state) that may add API calls not present in upstream
