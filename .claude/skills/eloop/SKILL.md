---
name: evolve_loop
description: 12-hour autonomous evolution loop for the AO agent-orchestrator fork. Repo-local override — use this for agent-orchestrator-specific PRs, workers, and beads. Falls back to the user-scope /eloop for generalized harness-evolution patterns.
type: skill
...

# Evolve Loop — Agent Orchestrator Fork

**This is the repo-local override.** For generalized harness-evolution principles that apply across all repos, also consult the user-scope `eloop` skill: `~/.claude/skills/evolve-loop/SKILL.md`.

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
- Worker stuck for 3 checks: kill and respawn, skip full diagnosis
- Build broken on main: fix immediately

For chronic problems, read the automation code rather than just checking infrastructure.

## Loop Body

### Phase 1: Observe

1. **Memory search first** — Run `/ms` (memory_search) to pull prior context for tracked PRs and friction points:
   ```sh
   /ms "open PRs jleechanorg/agent-orchestrator"
   /ms "open PRs jleechanclaw"
   /ms "stuck PRs zero-touch"
   /ms "bead bd- [recent]"
   ```
   This surfaces what happened in previous cycles, what was already dispatched, and what blockers are known — so the loop doesn't repeat work or miss context.

2. Run `/auton` for autonomy diagnostics when the local `auton` skill matches the current repo/system. If the available `auton` skill is repo-specific and does not fit the current target, do the equivalent local health triage directly instead of forcing the wrong diagnostic.
3. Check AO workers for:
   - `jleechanorg/agent-orchestrator`
   - `jleechanorg/worldai_claw`
   - `jleechanorg/jleechanclaw`
   - Antigravity orchestrator if relevant
4. Capture the last 30 lines from each active AO worker tmux pane.
5. Sweep merged-PR zombies and kill workers burning tokens on merged work.
6. Read recent friction narratives in `novel/` and `docs/novel/`.

Reference commands:

```bash
tmux list-sessions 2>/dev/null | grep -E '(ao|jc|wa|cc|ra|wc)-[0-9]+'

for repo in agent-orchestrator worldai_claw jleechanclaw; do
  gh api "repos/jleechanorg/$repo/pulls?state=open&per_page=20" \
    --jq '.[]|"\(.number) \(.head.ref) \(.mergeable_state)"' 2>/dev/null
done

for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^([a-f0-9]+-)?(ao|jc|wa|wc|cc|ra)-[0-9]+$'); do
  echo "=== $sess ==="
  tmux capture-pane -t "$sess" -p 2>/dev/null | tail -30
done
```

Merged-PR zombie sweep:

```bash
for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^([a-f0-9]+-)?(ao|jc|wa|wc|cc|ra)-[0-9]+$'); do
  pr_num=$(tmux capture-pane -t "$sess" -p 2>/dev/null | grep -oE "PR: #[0-9]+" | head -1 | grep -oE "[0-9]+")
  [ -z "$pr_num" ] && continue
  case "$sess" in
    ao-*|*-ao-*) repo="jleechanorg/agent-orchestrator" ;;
    jc-*|*-jc-*) repo="jleechanorg/jleechanclaw" ;;
    wa-*|*-wa-*) repo="jleechanorg/worldarchitect.ai" ;;
    wc-*|*-wc-*) repo="jleechanorg/worldai_claw" ;;
    *) continue ;;
  esac
  merged=$(gh api "repos/$repo/pulls/$pr_num" --jq '.merged' 2>/dev/null)
  if [ "$merged" = "true" ]; then
    tmux kill-session -t "$sess" 2>/dev/null || true
  fi
done
```

### Phase 2: Measure

Calculate the `[agento]` zero-touch rate from merged PRs in the last 24 hours.

```bash
SINCE_ISO=$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc) - timedelta(hours=24)).isoformat().replace("+00:00", "Z"))
PY
)

gh api 'repos/jleechanorg/agent-orchestrator/pulls?state=closed&per_page=30&sort=updated&direction=desc' \
  --jq ".[] | select(.merged_at != null and .merged_at > \"$SINCE_ISO\") |
    {number, title: .title[:70], agento: (.title | test(\"^\\[agento\\]\"))}"
```


For each non-`[agento]` merged PR, identify why it was not autonomous.

### Phase 3: Diagnose

1. Run `/harness` on each new friction point.
2. Check existing open beads and avoid duplicates.
3. Detect stale `in_progress` beads with no live worker.
4. If zero-touch rate is chronically below threshold, audit:
   - `.github/workflows/skeptic-cron.yml`
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
3. Push roadmap and bead updates to `origin/main`.

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
3. Run `/er` inline on PRs approaching 7-green.
4. If `/claw` fails, fall back to manual worktree or direct fix and record the failure.
5. Never merge without explicit 7-green verification.

Dispatch template:

```bash
/claw "Fix bd-XXX: <description>.

After implementing:
1. Run /er on the PR evidence bundle to validate authenticity
2. Ensure 7-green (CI, no conflicts, CR APPROVED, Bugbot clean, comments resolved, evidence reviewed, Skeptic PASS)
3. Run /learn to capture reusable patterns"
```

Pre-merge gate check:

```bash
PR_NUM=NNN
REPO="jleechanorg/REPO"
STATE=$(gh api "repos/$REPO/pulls/$PR_NUM" --jq '{state, merged}')
CI=$(gh api "repos/$REPO/commits/$(gh api repos/$REPO/pulls/$PR_NUM --jq '.head.sha')/status" --jq '.state')
MERGEABLE=$(gh api "repos/$REPO/pulls/$PR_NUM" --jq '.mergeable_state')
CR=$(gh api "repos/$REPO/pulls/$PR_NUM/reviews" --jq '[.[] | select(.user.login=="coderabbitai[bot]") | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")] | sort_by(.submitted_at) | last | .state // "NONE"')
UNRESOLVED=$(gh api graphql -f query='query($pr:Int!){repository(owner:"'$(echo $REPO|cut -d/ -f1)'",name:"'$(echo $REPO|cut -d/ -f2)'"){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}' -F pr=$PR_NUM --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length' 2>/dev/null || echo "?")
SKEPTIC=$(gh api "repos/$REPO/issues/$PR_NUM/comments" --jq '[.[] | select(.body | test("VERDICT:"; "i"))] | sort_by(.created_at) | last | .body' 2>/dev/null | grep -oiE "VERDICT: (PASS|FAIL|SKIPPED)")
```

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
- If a worker is stuck for 3 checks, kill and respawn
- If `/claw` fails twice on the same bead, fix directly
- If repo is on the wrong branch, switch to `main`
- If main is broken, fix it before dispatching workers

## Key Files

- `roadmap/evolve-loop-findings.md`
- `.beads/issues.jsonl`
- `~/.openclaw/SOUL.md`
- `~/.openclaw/agent-orchestrator.yaml`
- `novel/`
