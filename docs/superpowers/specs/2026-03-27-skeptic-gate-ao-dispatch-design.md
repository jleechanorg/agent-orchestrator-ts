# Skeptic Gate — AO Worker Dispatch Design

## Status

Author: claude
Date: 2026-03-27
Tracking: orch-rx8

## Problem

`skeptic-gate.yml` currently tries to install Codex/Claude CLI and run skeptic evaluation directly in GitHub Actions. This requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as repo secrets. Since those keys aren't configured (and shouldn't be), every PR gets `VERDICT: SKIPPED — ANTHROPIC_API_KEY not configured`.

The AO infrastructure for skeptic review already exists (bd-skp2):
- `skeptic-reviewer.ts` calls `ao skeptic verify --pr N`
- `fork-skeptic-extension.ts` implements the `skeptic-review` reaction
- `lifecycle-manager.ts` triggers `worker-signals-completion` → `skeptic-review` on PR open

The missing piece: wiring `skeptic-gate.yml` into this infrastructure without requiring API keys in GHA.

## Design Decision

**Comment-trigger pattern.** `skeptic-gate.yml` posts a trigger comment → lifecycle-manager detects it on next poll (every ~30s) → runs skeptic via existing reaction → posts VERDICT → GHA polls for VERDICT.

Why this approach:
- No webhook infrastructure needed (lifecycle-manager already polls)
- Reuses existing skeptic-review reaction code (bd-skp2)
- GHA only needs `GITHUB_TOKEN` (no API key secrets)
- No changes to lifecycle-manager core polling logic (just add comment detection)

## Architecture

```text
PR opened/updated
    │
    ▼
skeptic-gate.yml triggers
    │
    ├── Posts trigger comment: "🤖 [agento] Skeptic evaluation triggered on commit X"
    │
    ▼
lifecycle-manager poll (every ~30s)
    │
    ├── Detects trigger comment (github-actions[bot] + "Skeptic evaluation triggered")
    │
    ▼
skeptic-review reaction fires
    │
    ├── Calls runSkepticReviewReaction()
    │       │
    │       └── runSkepticReview()
    │               └── exec("ao skeptic verify --pr N --repo owner/repo")
    │                       │
    │                       └── ao skeptic verify:
    │                               ├── Fetches PR diff, reviews, merge gate
    │                               ├── llm-eval.ts → Codex/Claude (local keys)
    │                               └── Posts VERDICT: PASS/FAIL comment
    │
    ▼
GHA polling loop:
    ├── Every 30s: check for VERDICT comment from jleechan-agent[bot]
    └── On VERDICT: exit PASS/FAIL
```

## Changes Required

### 1. `.github/workflows/skeptic-gate.yml`
- Strip `anthropic_api_key` and `openai_api_key` from workflow and action calls
- Remove `skeptic-setup` action (no longer needed — no CLI installation)
- Add step to post trigger comment with idempotent marker
- Add polling loop to check for VERDICT comment (up to 30min timeout)
- Add `--paginate` to all `gh api` comment fetches
- Use `trigger_updated` output and `created_at > TRIGGER_UPDATED` filter to reject stale verdicts
- Use `--trigger-sha` and `<!-- skeptic-gate-trigger-$HEAD_SHA -->` marker for SHA binding

### 2. `~/.openclaw/agent-orchestrator.yaml`
- Add `worker-signals-completion` reaction with `skeptic-review` action

### 3. `packages/core/src/skeptic-reviewer.ts`
- Fetch PR head SHA via `gh api` and pass as `--trigger-sha` to `ao skeptic verify`
- Remove `workspacePath` requirement (backfill sessions may lack it)

### 4. `packages/cli/src/commands/skeptic.ts` + `posting.ts`
- Add `--trigger-sha` CLI option and pass through to `postVerdict`
- Embed `<!-- skeptic-gate-trigger-$SHA -->` marker in VERDICT comment body

### 5. `packages/core/src/fork-skeptic-extension.ts`
- No changes needed (already implemented)

## Data Flow Details

### Trigger Comment Format
```text
🤖 [agento] Skeptic evaluation triggered on commit `{sha}`.
_AO worker will evaluate and post VERDICT here._
<!-- skeptic-gate-trigger-{sha} -->
```

### VERDICT Comment Format
```text
🤖 Skeptic Agent — Independent Exit Criteria Verifier

## Verdict

**VERDICT: PASS** (or FAIL)

_This PR meets the skeptic exit criteria._ (or _fails on: ..._)
<!-- skeptic-agent-verdict -->
<!-- skeptic-gate-trigger-{HEAD_SHA} -->
```

> **Note:** The `<!-- skeptic-gate-trigger-{HEAD_SHA} -->` marker is required in the VERDICT body.
> The GHA polling loop filters by this marker to match verdicts to the correct evaluation window.

### Comment Detection Logic (lifecycle-manager)
```text
For each open PR:
  1. Fetch latest 5 comments from github-actions[bot]
  2. Look for comment matching: body contains "Skeptic evaluation triggered"
  3. Extract commit SHA from comment body
  4. Check: has this SHA already been processed? (store last-processed SHA in session metadata)
  5. If unprocessed: fire worker-signals-completion reaction with session matching PR
```

### GHA Polling Loop
```bash
# TRIGGER_UPDATED is the trigger comment's updated_at (ISO-8601)
# HEAD_SHA is the PR's current head commit SHA
MAX_ATTEMPTS=55  # 55 × 30s = 27.5 min (within 28-min step timeout)

for i in $(seq 1 $MAX_ATTEMPTS); do
  # --paginate ensures all comment pages are scanned (30 comments/page).
  # jq selects: jleechan-agent[bot] comment with VERDICT: AND
  # created_at > TRIGGER_UPDATED (staleness filter) AND
  # body contains "skeptic-gate-trigger-$HEAD_SHA" (SHA binding).
  VERDICT=$(gh api repos/OWNER/REPO/issues/N/comments \
    --paginate \
    --jq "[.[] | select(.user.login == \"jleechan-agent[bot]\"
      and (.body | test(\"VERDICT:\"; \"i\"))
      and (.created_at > \"$TRIGGER_UPDATED\")
      and (.body | test(\"skeptic-gate-trigger-\" + \"$HEAD_SHA\"; \"i\")))] | .[0] // empty")
  if echo "$VERDICT" | grep -qi "VERDICT: PASS"; then
    echo "verdict=PASS" >> $GITHUB_OUTPUT; exit 0
  elif echo "$VERDICT" | grep -qi "VERDICT: FAIL"; then
    echo "verdict=FAIL" >> $GITHUB_OUTPUT; exit 1
  fi
  sleep 30
done
echo "verdict=TIMEOUT" >> $GITHUB_OUTPUT; exit 1
```

## Error Handling

| Failure Mode | Behavior |
|---|---|
| Lifecycle-manager down | GHA times out after 30min, CI fails (GHA can't reach ao) |
| `ao skeptic verify` fails | VERDICT: FAIL posted, GHA exits FAIL |
| `ao` binary not found | FAIL logged in reaction result, no VERDICT posted |
| Comment deleted before GHA polls | Lifecycle-manager fires skeptic anyway (stateless check via SHA) |
| Concurrent runs (same PR) | `concurrency: cancel-in-progress` in GHA prevents this |

## Testing Plan

1. Open a test PR with intentionally broken code → expect VERDICT: FAIL
2. Open a test PR with passing CI + CR → expect VERDICT: PASS
3. Revise PR after initial evaluation → new trigger + VERDICT (idempotent)
4. Lifecycle-manager offline → GHA times out correctly

## Scope (What This Does NOT Cover)

- `skeptic-cron.yml` (runs skeptic on all open PRs on a cron schedule — separate workflow)
- Installing `ao` CLI in GHA (not needed with comment-trigger pattern)
- Changes to the skeptic evaluation criteria (handled by `packages/cli/src/commands/skeptic/`)
