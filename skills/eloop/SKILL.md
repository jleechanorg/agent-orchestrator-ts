---
name: eloop
description: Use when running an autonomous improvement loop against this Agent Orchestrator fork, especially when zero-touch rate, worker health, or recurring friction must be measured and improved.
---

# Evolve Loop — Agent Orchestrator Fork

**This is the canonical, self-contained repo workflow.** A user-scope evolve-loop
skill is optional background; no personal skill file is required. Observe before
acting, retain evidence for each diagnosis, preserve existing owners, and use the
target repository's current review contract. Operator limits on dispatch, cleanup,
paid work, and service changes take precedence over this workflow.

## Purpose

Autonomous self-improving loop for the agent-orchestrator fork. Observes the AO ecosystem (workers, PRs, workflows), measures zero-touch rate, diagnoses friction, creates beads for gaps, dispatches fixes via `/claw`, and records everything. Runs via `/loop 10m` for max 12 hours.

## Autonomous Continuation

After completing Phase 7, immediately start Phase 1 of the next cycle. Do not pause for confirmation between cycles.

The loop stops only when one of these is true:
1. User explicitly says `stop` or `pause`
2. 12 hours elapsed since first cycle
3. Context window exceeds 90%
4. System is stable for 3 consecutive healthy cycles

Treat "keep going" or "until stable" as standing directives.

## Adaptive Behavior

This loop is problem-driven.
- Healthy cycle: Observe -> Measure -> Recap
- Problem cycle: Observe -> Measure -> Diagnose -> Plan -> Record -> Fix -> Recap

Decision rules after Phase 2:
- Zero-touch rate unchanged and above 20%, no new friction, all workers alive: skip to recap
- Zero-touch rate below 20% for 3+ consecutive cycles: perform code-level diagnosis
- New dead worker or new PR failure: run diagnose through fix
- Worker stuck for 3 checks: inspect its existing session and owner before deciding on recovery; do not infer release from inactivity
- Build broken on main: fix immediately

For chronic problems, read the automation code rather than just checking infrastructure.

## Loop Body

### Phase 1: Observe

1. **Memory search first** — Run `/ms` (memory_search) to pull prior context for tracked PRs and friction points:
   ```
   /ms "open PRs jleechanorg/agent-orchestrator-ts"
   /ms "open PRs jleechanclaw"
   /ms "stuck PRs zero-touch"
   /ms "bead bd- [recent]"
   ```
   This surfaces what happened in previous cycles, what was already dispatched, and what blockers are known — so the loop doesn't repeat work or miss context.

2. Run `/auton` for autonomy diagnostics when the local `auton` skill matches the current repo/system. If the available `auton` skill is repo-specific and does not fit the current target, do the equivalent local health triage directly instead of forcing the wrong diagnostic.
3. Check AO workers for:
   - `jleechanorg/agent-orchestrator-ts`
   - `jleechanorg/worldai_claw`
   - `jleechanorg/jleechanclaw`
   - Antigravity orchestrator if relevant
4. Capture the last 30 lines from each active AO worker tmux pane.
5. Identify merged-PR workers and follow the managed cleanup checks below.
6. Read recent friction narratives in `novel/` and `docs/novel/`.

Reference commands:

```bash
tmux list-sessions 2>/dev/null | grep -E '(ao|jc|wa|cc|ra|wc)-[0-9]+'

for repo in agent-orchestrator-ts worldai_claw jleechanclaw; do
  gh api "repos/jleechanorg/$repo/pulls?state=open&per_page=20" \
    --jq '.[]|"\(.number) \(.head.ref) \(.mergeable_state)"' 2>/dev/null
done

for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^([a-f0-9]+-)?(ao|jc|wa|wc|cc|ra)-[0-9]+$'); do
  echo "=== $sess ==="
  tmux capture-pane -t "$sess" -p 2>/dev/null | tail -30
done
```

Merged-PR cleanup:

Use the AO project and session records, not tmux-name prefixes or PR numbers
scraped from terminal output. This covers both legacy unprefixed and namespaced
sessions without guessing which repository owns them. First inspect candidates:

```bash
: "${PROJECT_ID:?Resolve the configured AO project first}"
ao session cleanup --project "$PROJECT_ID" --dry-run
```

For each candidate, verify the recorded repository/PR is merged, the exact
workspace has no unpreserved or unpublished changes, the owner has released it,
and cleanup is authorized. A merged PR alone does not release an owner's newer
work. Only then use `ao session kill "$SESSION_ID" --keep-session` with that
existing session ID. Check that AO records no active session and git no longer
registers its workspace. Record cleanup failures and continue observing other
candidates; never report a failed cleanup as complete or substitute a raw runtime
kill. If identity or authorization is uncertain, leave the candidate untouched.

### Phase 2: Measure

Calculate the `[agento]` zero-touch rate from merged PRs in the last 24 hours.

```bash
set -euo pipefail
CUTOFF=$(python3 -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
gh api --paginate 'repos/jleechanorg/agent-orchestrator-ts/pulls?state=closed&per_page=30&sort=updated&direction=desc' \
  | jq --arg cutoff "$CUTOFF" '.[] | select(.merged_at != null and .merged_at > $cutoff) |
    {number, title: .title[:70], agento: (.title | test("^\\[agento\\]"))}'
```

For each non-`[agento]` merged PR, identify why it was not autonomous.

### Phase 3: Diagnose

1. Run `/harness` on each new friction point.
2. Check existing open beads and avoid duplicates.
3. Detect stale `in_progress` beads with no live worker.
4. If zero-touch rate is chronically below threshold, audit:
   - The target repository's current CI/reviewer configuration (Skeptic cron was retired in this fork by PR #773)
   - `packages/core/src/lifecycle-manager.ts`
   - `~/.openclaw/agent-orchestrator.yaml`

Reference:

```bash
br list --open 2>/dev/null | head -30

cat .beads/issues.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        if d.get('status') == 'in_progress':
            print(f\"{d['id']} | {d.get('title','')[:60]}\")
    except: pass
" 2>/dev/null
```

### Phase 4: Plan

1. Run `/nextsteps`.
2. Prioritize fixes:
   - P0: unblock multiple stalled PRs
   - P1: prevent recurring friction
   - P2: nice-to-have improvements

### Phase 5: Record

1. Create or update beads for each new friction point.
2. Append findings to `roadmap/evolve-loop-findings.md`.
3. Make these edits in an isolated checkout on a dedicated branch. Stage only the
   intended roadmap and bead changes, commit with normal hooks, and push that
   branch for a pull request against the configured base. Use the repository's
   approved bead synchronization mechanism if one is configured. Never write a
   protected base branch directly or include another owner's pending changes.

Reference:

```bash
br create --priority P1 --title "..." --body "..." 2>/dev/null
```

Append:

```markdown
## YYYY-MM-DD HH:MM cycle

### Zero-touch rate: X% (N/M)
### New friction points: [list]
### Fixes dispatched: [list]
### Beads created: [list]
```

### Phase 6: Fix

1. Use `/claw` for each actionable bead.
2. Babysit open PRs that have no live worker.
3. Run `/er` inline on PRs approaching the target repository's required gates.
4. If `/claw` fails, fall back to manual worktree or direct fix and record the failure.
5. Never merge without explicit authorization and verification of every required
   gate. This fork uses 6-green after PR #773; consumer repositories may also
   require Skeptic. Follow their configuration rather than assuming a waived gate.

Dispatch template:

```bash
/claw "Fix bd-XXX: <description>.

After implementing:
1. Run /er on the PR evidence bundle to validate authenticity
2. Verify all required gates (CI, no conflicts, CR APPROVED, Bugbot clean, comments resolved, evidence reviewed, plus Skeptic PASS where required)
3. Run /learn to capture reusable patterns"
```

Pre-merge gate check:

```bash
set -euo pipefail
: "${PR_NUM:?Set the PR number to verify}"
REPO=${REPO:-jleechanorg/agent-orchestrator-ts}
bash scripts/pr-rescue-status.sh "$REPO" "$PR_NUM"
```

This structural check is necessary, not permission to merge or proof of an
independent evidence review. If the target requires Skeptic, use its authorized
verifier with the current `--trigger-sha` and `--request-id`. The canonical
`packages/cli/src/commands/skeptic/verdict-utils.ts` parser must yield `PASS`, and
`isFreshPassVerdictContractSatisfied` must validate the current head, request ID,
and complete passing gate markers from the configured trusted reviewer. Treat
`SKIPPED`, stale, missing, malformed, or untrusted results as blocked. Do not scrape
the latest comment or synthesize a verdict. Recheck the head after review; a new
commit invalidates evidence tied to the old head.

### Phase 7: Recap

Summarize:

```text
## Evolve Loop Cycle — HH:MM
- Zero-touch rate: X% (trend)
- Workers: N alive, N dead, N stuck
- Open items: N open, N closed since last cycle
- Friction: N new points found
- Fixes: N dispatched, N direct
- Beads: N created, N updated
- Findings: pushed to roadmap/evolve-loop-findings.md
```

Touch the timestamp file after recap:

```bash
touch /tmp/evolve_loop_last_run
```

## Invocation

- Start loop: `/loop 10m /eloop`
- One cycle: `/eloop`
- With Antigravity: `/loop 10m /eloop and /antig`

## Anti-Stall Rules

- If GraphQL is exhausted, switch to REST immediately
- If session cap is hit, do not spawn
- If a worker is stuck for 3 checks, diagnose its existing session and preserve ownership before any authorized recovery
- If `/claw` fails twice on the same bead, fix directly
- If a repo is on the wrong branch, follow `skills/ao-lifecycle-triage/SKILL.md`; never switch a dirty or owned checkout
- If main is broken, fix it before dispatching workers

## Key Files

- `roadmap/evolve-loop-findings.md`
- `.beads/issues.jsonl`
- `~/.openclaw/SOUL.md`
- `~/.openclaw/agent-orchestrator.yaml`
- `novel/`

## Offline example validation

Run `python3 tests/unit/test_owned_skill_examples.py` from the repository root.
The tests execute read-only examples with fake GitHub/tmux commands and check
negative CI/review cases. They never dispatch or terminate a real AO session.
