---
name: agento_report
description: Generate a full agento PR status report — 6-point green checks, zero-touch rate, display inline, and post to Slack #ai-slack-test.
type: skill
---

## Purpose

Produce a comprehensive status report for all PRs agento is handling in `jleechanorg/agent-orchestrator`. Includes per-PR 6-green checks AND zero-touch-by-operator rate analysis. Display inline and post summary to Slack.

---

## Execution Steps

### Step 1 — Collect open PRs

Use REST (not GraphQL — GraphQL is frequently exhausted):

```bash
gh api "repos/jleechanorg/agent-orchestrator/pulls?state=open&per_page=30&sort=updated" \
  --jq '.[] | "\(.number)\t\(.head.ref)\t\(.title[:60])"'
```

Also collect recently merged (last 24h):
```bash
gh api "repos/jleechanorg/agent-orchestrator/pulls?state=closed&per_page=30&sort=updated&direction=desc" \
  --jq '.[] | select(.merged_at != null) | "\(.number)\t\(.head.ref)\t\(.title[:70])\t\(.merged_at)"'
```
Filter merged ones to last 24h by comparing `.merged_at` timestamp.

### Step 2 — Per-PR data fetch (open PRs)

For each open PR number NUM, fetch mergeability, CI, and reviews via REST:

```bash
# Mergeability (REST returns boolean mergeable + string mergeable_state)
gh api "repos/jleechanorg/agent-orchestrator/pulls/NUM" \
  --jq '{mergeable, mergeable_state}'

# CI checks
SHA=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/NUM" --jq '.head.sha')
gh api "repos/jleechanorg/agent-orchestrator/commits/$SHA/check-runs" \
  --jq '.check_runs[] | {name, status, conclusion}'

# Reviews
gh api "repos/jleechanorg/agent-orchestrator/pulls/NUM/reviews" \
  --jq '.[] | {user: .user.login, state}'

# Inline comments (check for High Severity / Critical / Major blockers)
gh api "repos/jleechanorg/agent-orchestrator/pulls/NUM/comments" \
  --jq '[.[] | select(.body | test("High Severity|Critical|Major"))] | length'
```

### Step 3 — 6-point green check per open PR

Apply all 6 conditions:

| # | Condition | Pass criteria |
|---|-----------|---------------|
| 1 | CI passing | All check-runs completed with SUCCESS, NEUTRAL, or SKIPPED — no FAILURE |
| 2 | No conflict | `mergeable_state` is `clean` (not `dirty` or `unstable`) |
| 3 | CodeRabbit APPROVED | Last `coderabbitai[bot]` review state is `APPROVED` |
| 4 | Bugbot OK | Last `cursor[bot]` check conclusion is `neutral` or `success` |
| 5 | No blocking comments | Zero inline comments with "High Severity", "Critical", or "Major" |
| 6 | Evidence PASS | `/er` comment with PASS exists (skip if no evidence bundle) |

**Status label** (pick worst failing condition):
- `GREEN` — all 6 pass
- `CONFLICT` — mergeable_state is `dirty`
- `CI_FAILED` — any check has FAILURE conclusion
- `CI_PENDING` — checks still in_progress
- `NO_CR` — CodeRabbit hasn't APPROVED
- `CR_CHANGES_REQUESTED` — CodeRabbit posted CHANGES_REQUESTED
- `COMMENTS` — unresolved High/Critical/Major comments
- `NO_EVIDENCE` — evidence check failed (skip if N/A)

### Step 4 — Zero-touch rate analysis (KEY ADDITION)

**Definition** (from `~/.openclaw/SOUL.md`): Zero-touch-by-operator is measured by the **`[agento]`** prefix in the PR title. A merged PR with `[agento]` prefix means AO produced the work and brought it to merge without operator intervention.

For each merged PR in the window:

```bash
gh api "repos/jleechanorg/agent-orchestrator/pulls?state=closed&per_page=30&sort=updated&direction=desc" \
  --jq '.[] | select(.merged_at != null) | {
    number,
    title: .title[:70],
    merged_at,
    agento: (.title | test("^\\[agento\\]"))
  }'
```

Calculate:
- **Total merged** in window
- **[agento] tagged** (zero-touch)
- **Non-[agento]** (operator-assisted)
- **Zero-touch rate** = agento_count / total_merged * 100

For each non-[agento] PR, note WHY it wasn't zero-touch — common reasons:
- Missing `[agento]` prefix (worker didn't tag it)
- Operator had to fix lint/build errors on main
- Operator manually resolved merge conflicts
- Operator directly pushed code fixes
- CR review required operator comments

### Step 5 — Format and display the report inline

```
## Agento Status Report — YYYY-MM-DD HH:MM

### Summary
- Repo: jleechanorg/agent-orchestrator
- Open PRs: N
- GREEN (ready to merge): N
- Not green: N
- Merged (last 24h): N
- Zero-touch rate (24h): X% (N/M [agento]-tagged of M total merged)

### Open PRs

| PR | Branch | Status | Blockers |
|----|--------|--------|----------|
| [#NUM](URL) title | branch | GREEN/status | blocker details |

### Merged (last 24h)

| PR | Title | Zero-touch? | Notes |
|----|-------|-------------|-------|
| [#NUM](URL) | title | [agento] YES / NO | reason if NO |

### Zero-Touch Analysis
- Rate: X% (N/M)
- Non-zero-touch PRs and why:
  - #NUM: reason (e.g., "operator fixed lint on main before CI could pass")
  - #NUM: reason (e.g., "worker didn't add [agento] prefix")

### AO Sessions
(tmux session count + key worker status)
```

### Step 6 — Post Slack summary via MCP

Post to `#ai-slack-test` (channel ID: `C0AKALZ4CKW`):

```
mcp__slack__conversations_add_message(
  channel_id="C0AKALZ4CKW",
  text="*Agento Status Report — YYYY-MM-DD HH:MM*\n\nRepo: jleechanorg/agent-orchestrator\nOpen: N PRs | GREEN: N | Not green: N\nMerged (24h): N | Zero-touch rate: X%\n\n<per-PR details>"
)
```

---

## Notes

- Scope: `jleechanorg/agent-orchestrator` (not jleechanclaw — that repo is deprecated for AO work).
- Use REST API (`gh api`) not GraphQL (`gh pr view --json`) — GraphQL is frequently exhausted.
- `mergeable_state` from REST: `clean`, `dirty`, `unstable`, `unknown`.
- Zero-touch convention: `[agento]` prefix in PR title (from `~/.openclaw/SOUL.md`).
- If `ao status` is unavailable, use `tmux list-sessions | grep -E 'ao-[0-9]+'` as fallback.
- Always display inline report FIRST, then post Slack.
- The Slack post uses MCP, NOT curl.
