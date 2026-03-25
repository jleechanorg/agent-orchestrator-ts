---
name: evolve_loop
description: 12-hour autonomous evolution loop — observe, measure, diagnose, fix, repeat every 10min. Drives zero-touch rate up by finding friction and dispatching fixes.
type: skill
---

## Purpose

Autonomous self-improving loop that observes the AO ecosystem, measures zero-touch rate, diagnoses friction, creates beads for gaps, dispatches fixes via /claw, and records everything. Runs via `/loop 10m` for max 12 hours.

---

## Adaptive Behavior — NOT Every Phase Every Cycle

This loop is problem-driven. If the system is healthy:
- **Healthy cycle** (~30s): Observe → Measure → Recap "all good, waiting"
- **Problem cycle** (~5min): Observe → Measure → Diagnose → Plan → Record → Fix → Recap

Decision tree after Phase 2 (Measure):
- Zero-touch rate unchanged AND no new friction AND all workers alive → SKIP to Phase 7 (Recap)
- New dead worker or new PR failure → run Phase 3-6
- Worker stuck (same output 3 checks) → kill + respawn, skip full diagnosis
- Build broken on main → fix immediately, skip /harness

---

## Loop Body (executed every 10 minutes)

### Phase 1: OBSERVE — System State Snapshot

**1a. Run /auton** — get autonomy diagnostic across all repos.

**1b. Check AO workers** — for each repo AO manages:
- `jleechanorg/agent-orchestrator` (primary)
- `jleechanorg/worldai_claw` (worldai)
- `jleechanorg/jleechanclaw` (orchestration — deprecated but may have active workers)
- Antigravity orchestrator (special — check launchd daemon status)

```bash
# List active AO sessions
tmux list-sessions 2>/dev/null | grep -E '(ao|jc|wa|cc|ra|wc)-[0-9]+'

# Per-repo open PRs
for repo in agent-orchestrator worldai_claw jleechanclaw; do
  gh api "repos/jleechanorg/$repo/pulls?state=open&per_page=20" \
    --jq '.[]|"\(.number) \(.head.ref) \(.mergeable_state)"' 2>/dev/null
done
```

**1c. Read worker tmux conversations** — capture last 30 lines from each active ao-* worker. Look for:
- Stuck patterns (same output for 10+ min)
- Error loops (repeated failures)
- Waiting for input
- Context exhaustion (>80%)

```bash
for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^(bb5e6b7f8db3-)?(ao|jc|wa|wc)-[0-9]+$'); do
  echo "=== $sess ==="
  tmux capture-pane -t "$sess" -p 2>/dev/null | tail -30
done
```

**1d. Read fiction/novel entries** — workers write friction narratives in `novel/` and `docs/novel/`:
```bash
# Check for recent novel entries (last 24h)
find novel/ docs/novel/ -name '*.md' -newer /tmp/evolve_loop_last_run 2>/dev/null
# Read any new entries for friction signals
```

### Phase 2: MEASURE — Zero-Touch Rate

Calculate the [agento] zero-touch rate per the SOUL.md convention:

```bash
# Merged PRs in last 24h with [agento] tag analysis
gh api 'repos/jleechanorg/agent-orchestrator/pulls?state=closed&per_page=30&sort=updated&direction=desc' \
  --jq '.[] | select(.merged_at != null and .merged_at > "YESTERDAY_ISO") |
    {number, title: .title[:70], agento: (.title | test("^\\[agento\\]"))}'
```

For each **non-[agento]** merged PR, determine WHY:
- Missing prefix (tagging gap) → bead if no existing bead
- Operator had to fix code directly → bead for the root cause
- Manual conflict resolution → bead for the conflict pattern
- CR/review required operator action → bead for review automation gap

### Phase 3: DIAGNOSE — Root Cause Analysis

**3a. Run /harness** on each new friction point found. /harness asks:
- Is this a harness gap (tests, CI, hooks, instructions)?
- What systemic fix prevents recurrence?
- 5 Whys on both the technical failure AND why the agent went down that path

**3b. Check existing beads** — don't duplicate:
```bash
br list --open 2>/dev/null | head -30
```

### Phase 4: PLAN — Next Steps

**4a. Run /nextsteps** — situational assessment and roadmap update.

**4b. Prioritize** — rank fixes by impact on zero-touch rate:
- P0: Fixes that unblock multiple stalled PRs
- P1: Fixes that prevent recurring friction patterns
- P2: Nice-to-have improvements

### Phase 5: RECORD — Beads + Roadmap + Push

**5a. Create/update beads** for each new friction point:
```bash
br create --priority P1 --title "..." --body "..." 2>/dev/null
```

**5b. Update roadmap doc** — append findings to `roadmap/evolve-loop-findings.md`:
```markdown
## YYYY-MM-DD HH:MM cycle

### Zero-touch rate: X% (N/M)
### New friction points: [list]
### Fixes dispatched: [list]
### Beads created: [list]
```

**5c. Push to origin main**:
```bash
git add roadmap/evolve-loop-findings.md .beads/issues.jsonl
git commit -m "docs(evolve): cycle YYYY-MM-DD HH:MM — zero-touch X%, N friction points"
git push origin main
```

### Phase 6: FIX — Dispatch Workers

**6a. Use /claw** for each actionable bead:
```bash
# /claw dispatches to ao spawn or manual worktree+claude
/claw "Fix bd-XXX: <description>. After completing, run /learn."
```

**6b. If /claw fails** (GraphQL exhausted, session cap, etc.):
- Fall back to manual worktree + `claude --dangerously-skip-permissions` in tmux
- Or create PR directly if the fix is small (config change, agentRules edit)
- Record the /claw failure in a bead

**6c. REST API fallback** — always prefer REST over GraphQL:
```bash
# Merge via REST
gh api repos/OWNER/REPO/pulls/NUM/merge --method PUT -f merge_method=squash

# Create PR via REST
gh api repos/OWNER/REPO/pulls --method POST -f title="..." -f head="BRANCH" -f base="main" -f body="..."

# Post comment via REST
gh api repos/OWNER/REPO/issues/NUM/comments --method POST -f body="..."
```

### Phase 7: RECAP — Cycle Summary

Output a concise cycle summary:
```
## Evolve Loop Cycle — HH:MM
- Zero-touch rate: X% (trend: ↑/↓/→)
- Workers: N alive, N dead, N stuck
- PRs: N open, N merged since last cycle
- Friction: N new points found
- Fixes: N dispatched via /claw, N direct
- Beads: N created, N updated
- Roadmap: pushed to main
```

Touch the timestamp file for next cycle:
```bash
touch /tmp/evolve_loop_last_run
```

---

## Invocation

```bash
# Start the loop (via /loop skill)
/loop 10m /eloop

# Or manually for one cycle
/eloop
```

The `/loop` wrapper handles the 12-hour max and 10-minute interval. Each `/eloop` invocation runs one complete cycle.

## Anti-Stall Rules

- If GraphQL is exhausted, switch to REST immediately — never sleep-retry
- If session cap is hit (>30), do not spawn — report and defer
- If a worker is stuck (same output 3 consecutive checks), kill and respawn
- If /claw fails twice on the same bead, create PR directly
- If main repo is on wrong branch, fix it silently (git checkout main)
- If build is broken on main, fix it before dispatching workers

## Key Files

- `roadmap/evolve-loop-findings.md` — cumulative findings log
- `.beads/issues.jsonl` — bead tracker
- `~/.openclaw/SOUL.md` — zero-touch convention ([agento] prefix)
- `~/.openclaw/agent-orchestrator.yaml` — agentRules config
- `novel/` — worker friction narratives
