# GitHub API Call Minimization Redesign

**Date:** 2026-03-21  
**Status:** Draft for implementation  
**Scope:** `jleechanorg/agent-orchestrator` fork runtime + workflows

---

## Direction Update (2026-03-21, thread decision)

To stay upstream-compatible and minimize churn:

- **GraphQL remains default** for existing AO paths.
- **REST is fallback-only** when GraphQL rate-limit/errors occur.
- **Worktree-first, PR-last**: do iterative work in worktrees and create/update PRs at milestone boundaries, not every micro-step.
- **Minimize core diffs**: prefer plugin/wrapper/config changes over lifecycle-manager rewrites.

## Problem Statement

Current automation still makes too many repeated `gh`/GitHub API reads across parallel sessions. The waste pattern is:

1. Multiple sessions ask the same PR status questions independently.
2. Polling loops re-fetch full PR state when only one field changed.
3. GraphQL is used for read paths that can be served by REST or cache.
4. Agents run direct `gh` checks in-loop instead of using shared snapshots.

This causes rate-limit exhaustion and stalls autonomy loops.

---

## Goals

1. **Reduce total GitHub API calls by 80–95%** during steady-state PR remediation.
2. **Prefer REST for reads**; reserve GraphQL for operations with no REST equivalent.
3. **Eliminate duplicate reads** across concurrent sessions.
4. **Fail soft under rate-limit pressure** (defer/non-critical checks) instead of thrashing.
5. **Preserve correctness** for merge-readiness decisions.

---

## Non-Goals

- Replacing AO lifecycle semantics.
- Redesigning merge policy (6-green logic remains policy-level).
- Eliminating GitHub API use entirely (not feasible).

---

## Target Architecture

## 1) Single GitHub State Aggregator (read-through cache)

Create a shared `github-state` module/service used by lifecycle + agents:

- Maintains per-PR snapshots with short TTLs.
- Deduplicates in-flight identical requests (single-flight).
- Exposes typed getters:
  - `getPrCore(pr)` (state, mergeable, head sha)
  - `getCiSummary(pr)`
  - `getReviewSummary(pr)`
  - `getThreadSummary(pr)`

**Rule:** direct `gh pr view/checks` in loops is disallowed for normal paths.

## 2) Two-tier freshness model

- **Hot fields** (CI conclusion, review decision): TTL 15–30s
- **Warm fields** (thread counts, metadata): TTL 60–180s

This cuts repeated reads while keeping merge checks fresh enough.

## 3) Event-first updates, polling-second

Use webhook/push events to invalidate cache keys and trigger selective refresh.
Polling remains as backstop with lower frequency.

- Webhook → invalidate `pr:<n>:ci|review|mergeable`
- Poller fallback every 3–5 min for drift correction

## 4) API budget manager

Add a runtime budget gate with per-hour quotas and operation classes:

- **Critical**: merge gate reads, failing CI diagnosis
- **Important**: review/thread refresh
- **Best-effort**: dashboards, broad scans

When budget is tight:
- Keep critical reads
- Stretch TTLs for important reads
- Pause best-effort reads

## 5) REST-first call map

Default read paths:
- PR core: `GET /repos/{owner}/{repo}/pulls/{number}`
- Reviews: `GET /pulls/{number}/reviews`
- Checks: `GET /commits/{sha}/check-runs`
- Combined status: `GET /commits/{sha}/status`

GraphQL only for:
- Review thread graph where REST cannot provide equivalent shape
- Thread resolution mutations

## 6) GraphQL mutation queue

For GraphQL-only actions (e.g., resolve thread):
- Queue mutations with retry metadata.
- Process when GraphQL budget is available.
- Emit explicit `deferred_by_rate_limit` state instead of hard failing loops.

## 7) Session behavior contract

Update agent rules:
- Use shared status snapshot helper first.
- Avoid repeated `gh` status probing in fix loops.
- Re-check only on trigger events (new commit/check/review), not fixed intervals.

---

## Rollout Plan

## Phase 0 — Instrumentation (1 day)

- Add call counters by endpoint + caller path.
- Add per-PR cache hit/miss metrics.
- Output hourly budget report.

**Exit criteria:** baseline call profile captured.

## Phase 1 — REST-first + cache core (2–3 days)

- Implement aggregator cache + single-flight.
- Route lifecycle read paths to aggregator.
- Replace direct GraphQL reads on hot paths with REST.

**Exit criteria:** >60% call reduction in staging load.

## Phase 2 — Budget-aware scheduler (1–2 days)

- Add operation classes and throttling logic.
- Dynamic TTL extension under low budget.
- Pause best-effort work when budget drops below threshold.

**Exit criteria:** no rate-limit hard-stop during 12-PR parallel run.

## Phase 3 — Event-first invalidation (2 days)

- Wire webhook-triggered cache invalidation.
- Lower poll frequency once event flow is stable.

**Exit criteria:** polling traffic reduced by at least 50% vs Phase 1.

## Phase 4 — GraphQL mutation queue (1–2 days)

- Queue + retry for thread mutations.
- Expose deferred state to lifecycle decisions.

**Exit criteria:** no loop stalls from GraphQL mutation rate limits.

---

## Bead Mapping (recommended)

- **bd-q3x**: implement aggregator + batch/snapshot strategy
- **bd-fy7**: GraphQL-to-REST fallback + mutation queue
- **bd-v92**: enforce session behavior contract (no direct status thrash)
- **bd-awq**: adapt poller to event-first + lower-frequency backstop

---

## Success Metrics

1. API calls / hour (total, REST, GraphQL)
2. Cache hit ratio (target >85% on read endpoints)
3. Rate-limit incidents/day (target ~0)
4. Mean time to green (must not regress)
5. PR loop stall count due to API exhaustion (target 0)

---

## Risks and Mitigations

- **Risk:** stale cache leads to false green decisions  
  **Mitigation:** critical merge checks force refresh when snapshot age >30s.

- **Risk:** webhook gaps create stale state  
  **Mitigation:** periodic drift poller remains enabled.

- **Risk:** hidden direct `gh` calls persist in scripts  
  **Mitigation:** lint/check for banned command patterns in hot paths.

---

## Immediate Next Step

Start with **Phase 0 + Phase 1** on `bd-q3x` as the fastest path to material call reduction.
