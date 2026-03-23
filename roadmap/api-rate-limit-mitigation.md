# API Rate Limit Mitigation (bd-gim)

Epic: **bd-gim** | Priority: P1 | Created: 2026-03-20

## Problem

Parallel `/polish` agents making 200+ GitHub API calls per cycle exhaust the 5000/hr GraphQL rate limit within 2-3 cycles. This blocks PR green checks and thread resolution for all 12 bd-pdt PRs simultaneously.

Secondary issue: CodeRabbit's COMMENTED state supersedes APPROVED after incremental reviews triggered by agent activity, with no reliable programmatic recovery path.

## Beads

| Bead | Title | Priority | Type |
|------|-------|----------|------|
| bd-q3x | Batch PR status checking | P1 | task |
| bd-fy7 | GraphQL-to-REST fallback | P2 | task |
| bd-77b | CR COMMENTED-after-APPROVED recovery | P1 | bug |

## Design

### bd-q3x: Batch PR Status Checking

**Goal**: Reduce per-PR API calls from ~20 to ~3 by batching.

- Single GraphQL query fetches all open PRs with CI status, review state, merge state, and thread counts
- Cache results for 60s; agents read cache instead of hitting API directly
- Estimated reduction: 200+ calls/cycle -> ~15 calls/cycle for 12 PRs

```graphql
query BatchPRStatus($owner: String!, $repo: String!, $prs: [Int!]!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 50, states: OPEN) {
      nodes {
        number
        mergeable
        reviewThreads(first: 100) { nodes { isResolved } }
        reviews(last: 5) { nodes { state author { login } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
```

### bd-fy7: GraphQL-to-REST Fallback

**Goal**: Automatically fall back to REST API when GraphQL quota is exhausted.

- Detect `RATE_LIMITED` errors from GraphQL responses
- Map critical operations to REST equivalents:
  - PR status: `GET /repos/{owner}/{repo}/pulls/{number}`
  - Reviews: `GET /repos/{owner}/{repo}/pulls/{number}/reviews`
  - Check runs: `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`
- Thread resolution has no REST equivalent — queue for retry after GraphQL reset
- REST has separate 5000/hr quota, providing effective 10000/hr combined capacity

### bd-77b: CR COMMENTED-after-APPROVED Recovery

**Goal**: Prevent or recover from CodeRabbit COMMENTED superseding APPROVED.

Root cause: When agents push fix commits to already-approved PRs, CodeRabbit posts incremental COMMENTED reviews that supersede the APPROVED state. Attempted workarounds that failed:
- `@coderabbitai resolve` — says "approved" in comment but doesn't change review state
- `@coderabbitai approve` — not a recognized command
- `@coderabbitai full review` — triggers new review but still posts as COMMENTED
- Dismissing COMMENTED reviews via API — returns null (can't dismiss COMMENTED state)

Proposed solutions (in priority order):
1. **Prevention**: Don't push to PRs that are already CR-approved unless necessary
2. **Config**: Investigate `.coderabbit.yaml` options for auto-approve when all threads resolved
3. **Workflow**: After fixes, post `@coderabbitai review` and wait for full re-review cycle
4. **Accept**: If CR is COMMENTED but all threads resolved, treat as equivalent to APPROVED for green checks

## Implementation Order

1. bd-q3x (batch queries) — immediate impact on rate consumption
2. bd-77b (CR state recovery) — unblocks 4 PRs currently stuck in COMMENTED
3. bd-fy7 (REST fallback) — defense-in-depth for future rate exhaustion
