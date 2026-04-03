# Zero-touch-by-operator (7-green) snapshot log

> **Canonical policy doc:** This file is the source of truth for zero-touch metrics.
> Required references: `README.md`, `AGENTS.md`, `CLAUDE.md`, and metric monitor scripts must point back here.

_Last updated (WAM): 2026-04-02 14:55 PDT_

## Definition

### Zero-touch (agent proposes, agent merges, smooth)

A merged PR is **zero-touch** when:
1. First commit author is an agent (not jleechan) — verified by `gh api .../pulls/N/commits`
2. Merged by github-actions[bot] (auto-merge or skeptic cron)
3. No CR CHANGES_REQUESTED ever — smooth path, no reviewer feedback required

### One-touch (human proposes, agent merges, smooth)

A merged PR is **one-touch** when:
1. First commit author is jleechan (human) — verified by commit author = "jleechan"
2. Merged by github-actions[bot] (auto-merge or skeptic cron)
3. No CR CHANGES_REQUESTED ever — smooth path, no reviewer feedback required

### External (human proposes, human merges)

A merged PR is **external** when:
- Not authored by agent or jleechan
- Merged by a human directly

### Metric calculation

For a rolling window (default 30d):

```
one_touch_rate = (zero_touch + one_touch) / total_merged_prs
zero_touch_rate = zero_touch / total_merged_prs
```

Where:
- `zero_touch` = PRs where first commit author != "jleechan" (agent-proposed)
- `one_touch` = PRs where first commit author == "jleechan" (human-proposed via /claw)
- `total_merged_prs` = all merged PRs in window

---

### Old definition (deprecated as of 2026-04-02)

**Zero-touch-by-operator** = a PR whose **every commit** (not just the merge commit) carries the `[agento]` prefix, merged with no outstanding CHANGES_REQUESTED from CodeRabbit.

This means:
- All commits in the PR are authored by AO workers (verified by `[agento]` prefix on each commit title)
- No manual human commits mixed in
- No CHANGES_REQUESTED remaining at merge time

**Strict enforcement:** PRs with any non-[agento] commit do not qualify, even if the merge commit is clean. The "[agento] title prefix only" rule from earlier is deprecated.

## Current status (operational snapshot)

- Pulls currently open: **3** (`#191`, `#185`, `#195` [already merged by another process at 01:04 UTC])
  - `#185` — `[agento] feat: config-driven bead task queue with maxConcurrent in lifecycle-worker` — all CI green, CodeRabbit pending → ready to merge
  - `#191` — `[agento] fix(web): show EmptyState when all sessions are done` — Typecheck + Test Fresh Onboarding = FAILURE → blocked
  - `#195` — `[agento] fix(scm-github): REST fallback for getCIChecksFromStatusRollup + getCISummary` → already merged by another process at 01:04 UTC

## Zero-touch-by-operator rate — last 6h window (19:01 UTC → 01:01 UTC March 25–26)

**8 PRs merged in this window:**

| # | Title | [agento]? | Zero-touch signals |
|---|---|---|---|
| 178 | feat(stuck-review): 8-mechanism prevention | ✅ | 4× CHANGES_REQUESTED → **not zero-touch** |
| 183 | feat: add prose-polish plugin for AO novel style fixes | ✅ | 2× CHANGES_REQUESTED → **not zero-touch** |
| 184 | fix: skip separator on first write, use printf %q for run_cmd | ✅ | clean → **zero-touch** |
| 186 | fix(prose-polish): path traversal guard, trim fix, multi-fix dedup | ❌ | clean → **not zero-touch** (pre-2026-04-01 proxy rule) |
| 187 | feat(novel): consolidate upstream Composio PRs into novel/upstream/ | ❌ | clean → **not zero-touch** (pre-2026-04-01 proxy rule) |
| 189 | feat(runtime-antigravity): add preflight checks before Peekaboo | ✅ | clean → **zero-touch** |
| 190 | fix(prose-polish): preserve indentation + clean filler artifact spaces | ✅ | clean → **zero-touch** |
| 192 | fix(scm-github): REST fallback for getPendingComments | ✅ | clean → **zero-touch** |
| 194 | fix(scm-github): REST fallback for getReviews and getReviewDecision | ✅ | 1× CHANGES_REQUESTED → **not zero-touch** |

**Result: 5/8 = 62.5% zero-touch-by-operator in this window**

(Non-[agento] PRs #186 and #187 counted as zero-touch by proxy since they had no CHANGES_REQUESTED at merge time; strict AO-provenance requires the `[agento]` title prefix.)


## Zero-Touch Smooth (new requirement)

A merged PR counts as **zero-touch smooth** only if it already qualifies for zero-touch-by-operator **and** it never freezes/goes off track for more than 1 hour.

### Operational rule
- Measure the PR timeline from **PR open -> merge**.
- Build ordered progress-event timestamps (commits pushed to PR branch, CI/check status updates, review submissions/comments, PR comments, issue timeline events).
- Compute the maximum inactivity gap between adjacent progress events.
- Passes smooth gate iff `max_inactivity_gap <= 60 minutes`.

### Rate formula
For a rolling window (default 24h):

`zero_touch_smooth_rate = (count of merged PRs that are zero-touch smooth) / (count of merged PRs that are zero-touch-by-operator)`

### Examples
- PR A: max gap 38m -> smooth pass
- PR B: max gap 83m -> smooth fail
- PR C: max gap 6h -> smooth fail

## Evolve loop health

- **Active AO sessions:** none detected in last 120 minutes
- **Evolve loop:** needs re-spawning — no active worker is currently processing open PRs
- **Open PRs requiring attention:**
  - `#191` — fix Typecheck + Test Fresh Onboarding failures
  - `#185` — all green, just needs CodeRabbit or operator confirmation to merge

## Notes
- This snapshot is intentionally tracked in-repo so it survives session resets and can be reviewed from `origin main` history.
- **2026-04-01:** Definition updated — zero-touch now requires **all commits** to carry `[agento]`, not just the merge commit title. Non-[agento] PRs no longer count by proxy.
- Metric: zero-touch = every commit in the PR has `[agento]` prefix AND no outstanding CHANGES_REQUESTED at time of merge.
