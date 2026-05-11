# FixPR Poller Plugin — Design Document

**Date:** 2026-05-11
**Status:** Draft — pending review
**Replaces:** `worldarchitect.ai/automation/` mctrl + pr-monitor + launchd stack

---

## 1. Problem

The current fixpr automation is a 3-layer stack:

```text
launchd (schedule)
  └─→ openclaw_mctrl_entry.sh (500-line safety wrapper)
        ├─→ ai_orch run --agent-cli minimax "<task>"
        └─→ jleechanorg-pr-monitor --fixpr (Python PR scanner)
              └─→ dispatch_agent_for_pr() (orchestrated_pr_runner.py:747)
                    └─→ TaskDispatcher.analyze_task_and_create_agents()
                          └─→ Spawns claude/minimax in tmux with /fixpr prompt
```

Issues:
- **Dead since 2026-03-08** — all 3 launchd agents were dead for 2 months (stale worktree paths, missing binaries, safety manager lockout)
- **mctrl is redundant** — AO now natively handles safety gates, failure budgets, stall detection, and CI monitoring
- **No merge-conflict detection** — the `poller-github-pr` plugin only watches for CodeRabbit `CHANGES_REQUESTED`; it ignores `mergeable=CONFLICTING` and failing CI checks
- **`ai_orch` is defunct** — the binary doesn't exist in PATH
- **No upstream equivalent** — composio agent-orchestrator has no merge-conflict or CI-failure poller

## 2. Proposed Solution

Extend the existing `poller-github-pr` plugin to cover the full fixpr scope, making it a **3-in-1 poller**:

| Work item type | Detection | Priority | Source |
|---|---|---|---|
| `changes-requested` | CodeRabbit `CHANGES_REQUESTED` | 2 | Existing |
| `merge-conflict` | `mergeable=CONFLICTING` or `mergeStateStatus=DIRTY` | 1 (highest) | **New** |
| `ci-failing` | Any check conclusion = `failure` | 1 | **New** |

This replaces the entire mctrl + pr-monitor + launchd stack with a single AO poller config.

### 2.1 Architecture

```yaml
agent-orchestrator.yaml
  projects:
    worldarchitect:
      pollers:
        fixpr:
          type: github-pr              ← extends existing plugin with modes
          enabled: true
          interval: 5m
          respawnCap:
            max: 3
            window: 12h
          modes:                        ← which work types to handle
            - merge-conflict
            - ci-failing
            - changes-requested
          agent: claude-code
          promptTemplate: fixpr          ← references prompt template below

AO lifecycle-manager (already runs)
  └─→ poller-manager
        └─→ poller-github-pr (with modes)
              ├─→ gh pr list --json ... (enriched query)
              ├─→ Detect: mergeable, statusCheckRollup, latestReviews
              └─→ Emit PollerWorkItem[] with type-specific metadata
                    └─→ sessionManager.spawn() with type-specific prompt
```

### 2.2 Key Changes

**A. Extend existing plugin: `packages/plugins/poller-github-pr/`**

This adds two new detection modes to the existing plugin:

1. **Merge-conflict detection** (ported from `jleechanorg_pr_monitor.py:609-645`):
   ```typescript
   // pr.mergeable is a MergeableState enum: MERGEABLE | CONFLICTING | UNKNOWN
   const isMergeConflict = pr.mergeable === "CONFLICTING";
   // pr.mergeStateStatus is a MergeStateStatus enum: BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE
   const isStateDirty = pr.mergeStateStatus === "DIRTY";
   ```

2. **CI-failure detection** (ported from `has_failing_checks()`):
   ```typescript
   // Conclusion values are uppercase enums from GitHub API
   const FAILING_CONCLUSIONS = new Set([
     "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED",
   ]);
   const isCIFailing = pr.statusCheckRollup?.some(c =>
     FAILING_CONCLUSIONS.has(c.conclusion?.toUpperCase())
   );
   ```

**B. Extended `gh pr list` query**

Current query:
```bash
--json number,title,url,isDraft,headRefName,baseRefName,statusCheckRollup,mergeable,latestReviews
```

New query adds:
```bash
--json ...,mergeStateStatus
```

This provides `DIRTY`/`CONFLICTING` status that the existing query misses.

**C. Type-specific prompt templates**

Each work type gets a tailored prompt:

| Type | Prompt key | Source logic |
|---|---|---|
| `merge-conflict` | `fixpr-merge-conflict` | Ported from `orchestrated_pr_runner.py:747-870` — the detailed merge-resolution steps |
| `ci-failing` | `fixpr-ci-failure` | Ported from the test-fix section of the same prompt |
| `changes-requested` | `fixpr-review-feedback` | Current poller behavior (CodeRabbit feedback) |

The prompts are stored as `promptTemplate` values in the config, not hardcoded in the plugin. This lets per-project configs customize the fixpr behavior.

**Template placeholders** — the existing `poller-manager` expands `{{url}}`, `{{title}}`, and `{{id}}`. The new modes require additional placeholders:

| Placeholder | Source | Example |
|---|---|---|
| `{{prNumber}}` | `pr.number` | `537` |
| `{{reasons}}` | work item `reasons` array | `merge-conflict, ci-failing` |
| `{{url}}` | existing | `https://github.com/...` |
| `{{title}}` | existing | `Fix the auth bug` |
| `{{id}}` | existing | `pr-537` |

The `poller-manager` template renderer must be extended to support `{{prNumber}}` and `{{reasons}}` before these prompts render correctly.

**D. Per-work-item metadata**

```typescript
// Extended PollerWorkItem metadata
{
  prNumber: 1234,
  branch: "feature/foo",
  baseBranch: "main",
  reasons: ["merge-conflict", "ci-failing"],  // can have multiple
  ciPassing: false,
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
  codeRabbitState: null,
  failingChecks: ["build", "test-e2e"],        // NEW: specific failed checks
}
```

**E. Config schema**

```yaml
projects:
  worldarchitect:
    name: "WorldArchitect AI"
    repo: "jleechanorg/worldarchitect.ai"
    path: "/Users/jleechan/worldarchitect.ai"
    defaultBranch: main
    sessionPrefix: wa
    agent: claude-code
    pollers:
      fixpr:
        type: github-pr
        enabled: true
        interval: 5m
        respawnCap:
          max: 3
          window: 12h
        modes:                        # which types to handle
          - merge-conflict
          - ci-failing
          - changes-requested
        approvalRequired:             # require human approval before spawning
          ci-failing: true            # CI fixes need approval (riskier changes)
          merge-conflict: false       # merge-conflict auto-approved (low risk)
          changes-requested: false    # review feedback auto-approved
        excludeDrafts: true           # skip draft PRs (default: true)
        maxPrs: 20                    # max PRs to scan per poll
        cutoffHours: 24              # only scan PRs updated within N hours
        agent: claude-code
        promptTemplate: |
          Fix PR #{{prNumber}}: {{title}}
          URL: {{url}}
          Issues: {{reasons}}

          PRIORITY ORDER:
          1. Resolve merge conflicts FIRST (if mergeable=CONFLICTING)
          2. Fix failing CI checks
          3. Address reviewer feedback
```

## 3. What Gets Removed

After migration, these become unnecessary:

| Component | Location | Action |
|---|---|---|
| `openclaw_mctrl_entry.sh` | `worldarchitect.ai/automation/` | Delete |
| `ai.worldarchitect.pr-automation.pr-monitor.plist` | `~/Library/LaunchAgents/` | Unload + delete |
| `jleechanorg-pr-monitor --fixpr` | `~/.local/bin/` | Keep binary (other uses), remove from fixpr flow |
| `orchestrated_pr_runner.py` dispatch | `worldarchitect.ai/automation/` | Remove `dispatch_agent_for_pr()` — logic moves to plugin |
| `ai_orch` CLI | N/A (already missing) | No action needed |
| Safety manager state | `/tmp/automation_safety/` | Delete |

## 4. Migration Steps

1. **Build the plugin extension** — extend `packages/plugins/poller-github-pr/` with mode detection
2. **Add project config** — add `worldarchitect` project to `agent-orchestrator.yaml`
3. **Install `ao` globally** — run `scripts/setup.sh` or `pnpm link --global` from `packages/ao`
4. **Start AO** — `ao start` (daemon + dashboard + poller-manager)
5. **Verify poller** — check dashboard for `fixpr` poller status
6. **Unload old launchd** — `launchctl unload ai.worldarchitect.pr-automation.pr-monitor.plist`
7. **Smoke test** — push a PR with a deliberate merge conflict, verify the poller detects it and spawns a session

## 5. Upstream Composio Comparison

**Searched upstream composio agent-orchestrator — no equivalent exists.** The upstream has:
- No `poller-github-pr` plugin (ours is a fork addition)
- No merge-conflict detection
- No CI-failure polling
- No `fixpr` concept

This plugin would be entirely fork-specific. If composio later adds PR polling, we can rebase onto it.

## 6. Porting Notes — Key Logic from `orchestrated_pr_runner.py`

The old fixpr prompt is ~300 lines (lines 747-950 of `orchestrated_pr_runner.py`). Key sections to port:

### 6.1 Merge conflict resolution (highest priority)

```bash
1. gh pr view {N} --json mergeable,mergeStateStatus
2. If mergeable=CONFLICTING or DIRTY:
   a. git fetch origin {branch}
   b. git checkout -B fixpr/{branch} origin/{branch}
   c. git fetch origin main && git merge origin/main --no-edit
   d. Resolve conflicts (configurable via conflictResolution map):
      - .beads/issues.jsonl → merge both sides + deduplicate
        (never use --ours; bead records from base must be preserved)
      - test files → usually --theirs
      - code files → manual resolution
   e. git add -A && git commit && git push
```

**Conflict resolution config** (per-project override):
```yaml
pollers:
  fixpr:
    conflictResolution:
      ".beads/issues.jsonl": "merge-deduplicate"  # default: preserve both sides
      "*.test.ts": "theirs"
      "*.snap": "theirs"
      "*": "manual"  # catch-all: require agent judgment
```

### 6.2 CI failure fix (human-approval required)

When `approvalRequired.ci-failing: true`, the poller does NOT spawn a fix
session automatically. Instead it:

1. Posts a PR comment describing the failing checks (the "notification comment")
2. Mentions the project's notified maintainer (via `notificationRouting`)
3. Waits for a `/fixpr ci` reply comment on the PR before spawning

**Authorization rules for `/fixpr ci` comments:**

| Rule | Detail |
|---|---|
| Trusted authors | Only comments from users with write-access to the repo are accepted |
| Freshness | Comment must be posted **after** the poller's notification comment |
| Head binding | The approval only applies to the current head SHA at the time the `/fixpr ci` comment is posted; if the branch advances, the approval is stale |
| Single-use dedupe | Once a `/fixpr ci` approval is consumed (spawn triggered), the same comment ID is recorded and not processed again on subsequent polls |
| Stale rejection | If the head SHA has changed since the `/fixpr ci` comment was posted, the approval is ignored and a new notification + approval cycle begins |

Once approved (or if `approvalRequired.ci-failing: false`):

```bash
1. gh pr view {N} --json statusCheckRollup
2. Identify failing checks
3. Run tests locally to reproduce
4. Apply fixes
5. Push and verify CI passes
```

### 6.3 Reviewer feedback

Already handled by the existing `poller-github-pr` plugin.

### 6.4 Safety guards to port

- **Pending review prohibition** — never use `create_pending_pull_request_review` MCP tool
- **Comment method** — use Python `post_pr_comment_python()` or `gh pr comment`, not MCP review tools
- **Commit markers** — `fixpr-{cli}` prefixed commit messages for tracking

## 7. Open Questions

1. **Should this be a separate plugin or extend `poller-github-pr`?**
   - Decision: **extend `poller-github-pr`** with a `modes` config option. The plugin name stays `github-pr`; the `modes` list selects which detection types are active. This avoids duplicating the 80% shared `gh pr list` logic.

2. **Should CI-failure remediation be automatic or require human approval?**
   - Decision: **human approval required for CI-failure**, automatic for merge-conflict
   - Mechanism: `approvalRequired` config field (see §2.2.E); when `ci-failing: true`, the poller posts a notification comment and waits for a `/fixpr ci` reply before spawning a fix session

3. **Poll interval?**
   - Decision: **5 minutes** with respawn cap (max 3 spawns per PR per 12h window)
   - Rationale: faster detection than the old twice-daily (12h) schedule, but respawn cap prevents runaway loops

4. **Agent selection per work type?**
   - merge-conflict → `claude-code` (most reliable at conflict resolution)
   - ci-failing → `claude-code` or `minimax` (depends on complexity)
   - changes-requested → project default

---

## Appendix A: Current `poller-github-pr` vs Proposed

| Feature | Current | Proposed |
|---|---|---|
| Detects CodeRabbit CHANGES_REQUESTED | ✅ | ✅ |
| Detects merge conflicts | ❌ | ✅ |
| Detects CI failures | ❌ | ✅ |
| Fetches `mergeStateStatus` | ❌ | ✅ |
| Type-specific prompts | ❌ | ✅ |
| Per-type priority | N/A | ✅ (conflict=1, CI=1, review=2) |
| Respawn cap | ✅ (poller-manager) | ✅ |
| REST fallback | ✅ | ✅ |
| Configurable fix modes | ❌ | ✅ |
| Draft exclusion | ✅ | ✅ |

## Appendix B: File Changes Summary

```text
packages/plugins/poller-github-pr/
  src/index.ts          — EXTEND with merge-conflict + CI detection
  src/approval-gate.ts  — NEW: /fixpr ci authorization enforcement
    - comment ingestion: scan PR comments for /fixpr ci after notification
    - collaborator check: verify comment author has repo write access
    - notification tracking: record notification comment ID + timestamp
    - approval dedupe: consumed-approval set prevents re-spawn
    - head-SHA binding: approval only valid for SHA at comment time
    - spawn gate: unapproved ci-failing work items held in pending queue
  src/approval-gate.test.ts  — NEW: unit tests for each authorization rule
  src/index.test.ts     — ADD tests for new detection modes
  package.json          — BUMP version

packages/core/src/types.ts  — ADD mergeStateStatus + ApprovalState to GitHubPR

agent-orchestrator.yaml      — ADD worldarchitect project + fixpr poller config
```
