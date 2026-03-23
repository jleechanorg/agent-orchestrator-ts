---
name: auton
description: Diagnose why ao (agent orchestrator) isn't autonomously bringing PRs to green. Reminds you to read the relevant CLAUDE.md and AGENTS.md files to understand the system design.
type: diagnostic
---

# /auton — Autonomy Diagnostic

Use this when PRs in `jleechanorg/agent-orchestrator` (or any managed repo) are sitting open and not being brought to green automatically.

## Step 1 — Read authoritative docs first (mandatory)

Before diagnosing, read these to understand what "working" looks like:

| File | Purpose |
|------|---------|
| `~/.openclaw/CLAUDE.md` | How the jleechanclaw harness works; what AO is supposed to do |
| `~/.openclaw/AGENTS.md` | PR green criteria, session startup, agent directives |
| `/Users/jleechan/project_agento/agent-orchestrator/CLAUDE.md` | This fork's dev hierarchy and isolation rules |
| `/Users/jleechan/project_agento/agent-orchestrator/AGENTS.md` | Fork-specific coding standards and test classification |
| `~/.openclaw/agent-orchestrator.yaml` | Live config: projects, reactions, notifiers, agentRules |

## Step 2 — How the system is supposed to work

```
GitHub PRs
    ↓  (AO polls every ~5 min via launchd / ao lifecycle-worker)
Reactions  (ci-failed, changes-requested, merge-conflicts, agent-stuck, approved-and-green)
    ↓  (ao spawn → Claude Code session with --dangerously-skip-permissions)
Agent  (reads comments → fixes code → pushes → posts @coderabbitai all good? → runs /er)
    ↓  (CI green, CR APPROVED, Bugbot neutral, comments resolved, evidence PASS)
Auto-merge  (orchestrator polls every 15 min, merges when all 6 criteria met)
```

**Key config**: `~/.openclaw/agent-orchestrator.yaml` → `projects.agent-orchestrator`
- `path:` must point to the actual repo on disk (`~/project_agento/agent-orchestrator`)
- `repo:` must be `jleechanorg/agent-orchestrator`
- `backfillAllPRs: true` to handle all open PRs (not just [agento]-tagged ones)
- `agentConfig.permissions: skip` for --dangerously-skip-permissions

## Step 3 — Diagnostic checklist

```bash
# 1. Is AO / openclaw running?
ps aux | grep -E "agent-orchestrator|openclaw" | grep -v grep
launchctl list | grep -E "ao|openclaw|agentorchestrator"

# 2. Check AO logs
tail -50 /tmp/ao-pr-poller.log 2>/dev/null || echo "no poller log"
tail -50 /tmp/ao-lifecycle-jleechanclaw.log 2>/dev/null || echo "no lifecycle log"

# 3. Are sessions being spawned?
tmux list-sessions | grep -E "^[a-z]{2}-" 2>/dev/null || echo "no ao sessions"

# 4. Is the path correct in config?
grep -A6 "agent-orchestrator:" ~/.openclaw/agent-orchestrator.yaml | grep path

# 5. Is openclaw notifier reachable?
curl -s http://127.0.0.1:18789/health 2>/dev/null || echo "openclaw not reachable"

# 6. Is orchestrator webhook reachable?
curl -s http://127.0.0.1:19888/health 2>/dev/null || echo "orchestrator not reachable"

# 7. Open PRs and their state
gh pr list --repo jleechanorg/agent-orchestrator --state open \
  --json number,title,mergeable,mergeStateStatus
```

## Step 4 — Common failure modes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| PRs sit with CI failing | AO not running | Start AO daemon / launchd plist |
| AO running but not touching PRs | Wrong `path:` in config | Fix path in agent-orchestrator.yaml |
| AO runs agents but they don't push | Missing `permissions: skip` | Add `agentConfig.permissions: skip` |
| Only [agento]-tagged PRs handled | Missing `backfillAllPRs` | Add `backfillAllPRs: true` to project |
| Sessions spawn but exit quickly | Stray worktree blocking claim | `git worktree prune` in repo |
| Agent runs but doesn't merge | 6-green check not passing | See criteria below |

## Step 5 — The 6 green criteria (from AGENTS.md / jleechanclaw)

All 6 must be true before the orchestrator auto-merges:

1. `mergeable == true` (no conflicts)
2. `mergeable_state` not dirty or unstable
3. CodeRabbit (`coderabbitai[bot]`) has reviewed
4. Bugbot (`cursor[bot]`) has reviewed
5. Bugbot's latest review is NOT `CHANGES_REQUESTED`
6. Evidence PASS comment: `**PASS** — evidence review: agent self-reviewed ✅, CR reviewed ✅, [codex/CR] passed ✅`

**Agents never run `gh pr merge`** — orchestrator does it every 15 min when all 6 met.

## Step 6 — Coordination: jleechanclaw ↔ agent-orchestrator

These two repos are tightly coupled:

| Repo | Role |
|------|------|
| `jleechanorg/jleechanclaw` (`~/.openclaw/`) | The harness — config, skills, plists, agent rules, orchestration Python |
| `jleechanorg/agent-orchestrator` (`~/project_agento/agent-orchestrator`) | The AO engine being developed |

- Config changes in `agent-orchestrator.yaml` (jleechanclaw) control which repos AO monitors
- Code changes in agent-orchestrator affect how AO polls, reacts, and spawns sessions
- If AO adds a new reaction type or feature, jleechanclaw config may need updating to use it
- PR path fix (done today): `path:` was `~/projects_reference/agent-orchestrator` → now `~/project_agento/agent-orchestrator`
