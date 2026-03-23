# Rate-limit unknown semantics for CI and review state

## Problem

`scm-github` currently maps some GitHub API rate-limit failures to semantic `"none"` values:

- CI summary can return `"none"` on rate-limit failure
- review decision can return `"none"` on rate-limit failure

`"none"` can also mean legitimate product states (for example: no CI checks configured). That conflates:

1. **Unknown because data fetch failed**
2. **Known and empty**

In mergeability flows, this can look optimistic when status is actually unknown.

## Desired behavior

Introduce an explicit `unknown_due_to_rate_limit` path so rate-limit failures are never represented as semantic `"none"`.

## Work items

1. Add explicit unknown status plumbing in SCM return types for CI and review decision.
2. Update mergeability to surface a blocker for unknown status (for example: `CI status unknown (rate limited)`).
3. Keep anti-spam behavior by suppressing repetitive retries/notifications while unknown is active.
4. Add regression tests for:
   - CI rate-limit in `getCISummary`
   - `reviewDecision` rate-limit in `getReviewDecision`
   - mergeability behavior with unknown status

## Acceptance criteria

- Unknown due to API/rate limit is distinguishable from semantic `"none"` in code and tests.
- Mergeability cannot become green solely because status became unknown.
- Existing non-rate-limit fail-closed behavior remains unchanged.

## Context

Follow-up to the rate-limit handling changes in PR #75 and bead `orch-06b`.
