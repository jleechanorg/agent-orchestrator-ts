# /auton — Autonomy Diagnostic

## Purpose

Diagnose WHY the jleechanclaw + AO system is NOT autonomously driving PRs to 6 green and merged. The system is supposed to do this without human intervention — if it isn't, something is broken.

**Skill reference**: `.claude/skills/auton.md`
**Session monitor skill**: `.claude/skills/ao-session-monitor.md`

## Usage

- `/auton` — Run full autonomy diagnostic
- `/auton <description>` — Focus on a specific failure mode

## Execution

**YOU (Claude) must execute the following steps immediately.**

### Step 1: Read the goals and system design (mandatory)

Before answering, read these files to understand what "working" means:

1. `~/.openclaw/CLAUDE.md` — repo goals, PR green definition, autonomy target
2. `~/.codex/AGENTS.md` — agent policies
3. `~/.openclaw/agent-orchestrator.yaml` — AO project config
4. `~/.openclaw/SOUL.md` — openclaw decision-making policy

### Step 2: Run diagnostics (parallel group A + B)

Run **Group A** and **Group B** in parallel for speed.

#### Group A — Infrastructure & Session State

Run all of these together:

```bash
# A1. Orchestrator session — what is it doing?
tmux capture-pane -t ao-orchestrator -p -S -20 2>/dev/null || echo "ORCHESTRATOR SESSION NOT FOUND"

# A2. Worker session inventory with activity detection (30 lines each)
# Uses ao-session-monitor skill: capture 30 lines, look for Unicode activity indicators
for s in $(tmux list-sessions 2>/dev/null | grep -E "ao-[0-9]|jc-" | cut -d: -f1); do
  echo "=== SESSION: $s ==="
  last=$(tmux capture-pane -t "$s" -p -S -30 2>/dev/null)
  echo "$last" | tail -5
  echo "---"
  # Detect state via activity indicators
  activity=$(echo "$last" | grep -oE "[✻✶✳✽✾✢] [A-Za-z]+" | tail -1)
  pr=$(echo "$last" | grep -oE "#[0-9]+" | head -1)
  uc=""; echo "$last" | grep -q "uncommitted" && uc="+uncommitted"
  if [ -n "$activity" ]; then
    echo "STATE: WORKING $pr $uc ($activity)"
  elif echo "$last" | grep -qE "Running|timeout"; then
    echo "STATE: WORKING (shell command) $pr $uc"
  elif echo "$last" | grep -qE "Baked|Sautéed"; then
    echo "STATE: COMPLETED $pr"
  elif echo "$last" | grep -q "queued"; then
    echo "STATE: QUEUED $pr"
  else
    echo "STATE: IDLE $pr $uc"
  fi
  echo ""
done

# A3. Is AO lifecycle-worker running? Check per-project
lw_count=$(ps aux | grep -c "[l]ifecycle-worker")
lw_per_project=$(ps aux | grep "[l]ifecycle-worker" | awk '{print $NF}' | sort -u | wc -l | tr -d ' ')
echo "Lifecycle-worker process count: $lw_count (unique projects: $lw_per_project)"
# Only flag as duplicate if same project appears more than once
ps aux | grep "[l]ifecycle-worker" | awk '{print $NF}' | sort | uniq -d | while read dup; do
  echo "DUPLICATE lifecycle-worker for project: $dup"
  ps aux | grep "[l]ifecycle-worker" | grep "$dup"
done

# A3b. ZOMBIE SESSION DETECTION — cross-reference AO session store vs tmux
echo "--- AO session store state (agent-orchestrator project) ---"
ao session ls --project agent-orchestrator 2>/dev/null || echo "ao session ls failed"
echo "--- Zombie check: AO-marked-killed sessions still in tmux ---"
# Discover session dirs dynamically — hash varies per config path
for ns_dir in ~/.agent-orchestrator/*-agent-orchestrator/sessions; do
  [ -d "$ns_dir" ] || continue
  echo "(scanning $ns_dir)"
done
AO_DATA=$(ls ~/.agent-orchestrator/*-agent-orchestrator/sessions/ 2>/dev/null)
for s in $AO_DATA; do
  sfile=$(ls ~/.agent-orchestrator/*-agent-orchestrator/sessions/"$s" 2>/dev/null | head -1)
  [ -f "$sfile" ] || continue
  status=$(grep "^status=" "$sfile" 2>/dev/null | cut -d= -f2)
  tmux_name=$(grep "^tmuxName=" "$sfile" 2>/dev/null | cut -d= -f2)
  [ "$status" = "killed" ] || continue
  if tmux has-session -t "$tmux_name" 2>/dev/null; then
    pr=$(grep "^pr=" "$sfile" | cut -d= -f2 | grep -oE "[0-9]+$")
    echo "  ZOMBIE: $s (tmux=$tmux_name, PR=#$pr) — AO=killed but tmux still running"
  fi
done

# A4. Stray worktrees blocking spawns?
git -C "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" worktree list 2>/dev/null | grep "locked" || echo "No locked worktrees"
```

#### Group B — GitHub & Rate Limits

Run all of these together:

```bash
# B1. Rate limits — check before making API calls
gh api rate_limit --jq '.resources | {core: .core.remaining, graphql: .graphql.remaining}'

# B2. Open PRs with status (REST — works when GraphQL=0)
gh api "repos/jleechanorg/agent-orchestrator/pulls?state=open" --jq '.[] | {number, title: .title[0:60], mergeable_state, branch: .head.ref}' 2>/dev/null

# B2b. Review states for each open PR (per-reviewer, not just global last)
for pr in $(gh api "repos/jleechanorg/agent-orchestrator/pulls?state=open" --jq '.[].number' 2>/dev/null); do
  # Get latest review state per reviewer to avoid hiding CHANGES_REQUESTED behind another reviewer's APPROVED
  reviews=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/$pr/reviews" --jq '
    [.[] | select(.state != "COMMENTED")]
    | group_by(.user.login)
    | map({reviewer: .[0].user.login, state: .[-1].state})
    | map("\(.reviewer)=\(.state)")
    | join(", ")
  ' 2>/dev/null)
  blocking=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/$pr/reviews" --jq '
    [.[] | select(.state != "COMMENTED")]
    | group_by(.user.login)
    | map(.[-1])
    | any(.state == "CHANGES_REQUESTED")
  ' 2>/dev/null)
  echo "PR #$pr reviews=[$reviews] blocking=$blocking"
done
```

### Step 3: Cross-reference — CHANGES_REQUESTED gap detection

After both groups complete, cross-reference:
1. From the Step B2b output, list PRs whose **latest per-reviewer review state** includes `CHANGES_REQUESTED`
2. Check if each CR_REQ PR has an active worker session (from Group A2)
3. If a CR_REQ PR has **no active session**, flag it as a gap — the orchestrator should be addressing it

### Step 3b: Stalled PR detection (>1hr gap, not 6-green)

For every open PR, check last commit date and compare to current UTC time. Flag any PR that:
- Is NOT at 6-green (any of: CI failing, merge conflict, CR not APPROVED, unresolved comments, Bugbot blocking)
- Has >1 hour since the last commit with no visible progress

```bash
# Stall detection — REST API (works even when GraphQL=0)
current_epoch=$(date -u +%s)
echo "=== STALLED PR DETECTION (>1hr gap, not 6-green) ==="
for pr in $(gh api "repos/jleechanorg/agent-orchestrator/pulls?state=open" --jq '.[].number' 2>/dev/null); do
  last_commit=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/$pr/commits" --jq '.[-1].commit.committer.date' 2>/dev/null)
  # Cross-platform date parsing: try BSD (macOS) first, then GNU (Linux)
  commit_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$last_commit" +%s 2>/dev/null || date -u -d "$last_commit" +%s 2>/dev/null || echo "")
  if [ -z "$commit_epoch" ]; then
    echo "SKIP #$pr — could not parse commit timestamp: $last_commit"
    continue
  fi
  gap_mins=$(( (current_epoch - commit_epoch) / 60 ))
  if [ "$gap_mins" -gt 60 ]; then
    pr_data=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/$pr" --jq '{mergeable_state, title: .title[0:55], branch: .head.ref}' 2>/dev/null)
    mergeable=$(echo "$pr_data" | jq -r '.mergeable_state')
    title=$(echo "$pr_data" | jq -r '.title')
    branch=$(echo "$pr_data" | jq -r '.branch')
    # Per-reviewer review state — check if any reviewer has CHANGES_REQUESTED
    review=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/$pr/reviews" --jq '
      [.[] | select(.state != "COMMENTED")]
      | group_by(.user.login) | map(.[-1].state)
      | if any(. == "CHANGES_REQUESTED") then "CHANGES_REQUESTED"
        elif any(. == "APPROVED") then "APPROVED"
        else "NONE" end
    ' 2>/dev/null)
    # Skip PRs that appear 6-green (clean + approved)
    if [ "$mergeable" = "clean" ] && [ "$review" = "APPROVED" ]; then
      continue
    fi
    # Check for worker on this branch
    has_worker="no"
    for s in $(tmux list-sessions 2>/dev/null | grep -E "ao-[0-9]+|jc-[0-9]+" | cut -d: -f1); do
      s_branch=$(tmux capture-pane -t "$s" -p 2>/dev/null | grep -oE "Branch: [^ ]+" | tail -1 | sed 's/Branch: //')
      [ "$s_branch" = "$branch" ] && has_worker="$s" && break
    done
    gap_hrs=$((gap_mins / 60))
    echo "STALLED #$pr | ${gap_hrs}h (${gap_mins}m) | review=$review | merge=$mergeable | worker=$has_worker | $title"
  fi
done
```

### Step 3c: 6-Green Rate — Zero-Touch PR Measurement

Measure how many merged PRs went to 6-green without human intervention. A PR is "zero-touch" if ALL commits have the `[agento]` prefix (no human commits).

```bash
# 6-Green rate — last 7 days
echo "=== 6-GREEN RATE (last 7 days) ==="
cutoff=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "7 days ago" +%Y-%m-%dT%H:%M:%SZ)
zero=0; human=0; total=0
for pr_json in $(gh api "repos/jleechanorg/agent-orchestrator/pulls?state=closed&sort=updated&direction=desc&per_page=50" --jq "[.[] | select(.merged_at != null) | select(.merged_at > \"$cutoff\")] | .[] | @base64" 2>/dev/null); do
  pr=$(echo "$pr_json" | base64 -D 2>/dev/null || echo "$pr_json" | base64 -d 2>/dev/null)
  number=$(echo "$pr" | jq -r '.number')
  title=$(echo "$pr" | jq -r '.title[0:50]')
  commits=$(gh api "repos/jleechanorg/agent-orchestrator/pulls/$number/commits" --jq '[.[] | .commit.message[0:50]]' 2>/dev/null)
  human_commits=$(echo "$commits" | jq '[.[] | select(test("^\\[agento\\]") | not)] | length')
  total_commits=$(echo "$commits" | jq 'length')
  total=$((total + 1))
  if [ "$human_commits" -eq 0 ]; then
    zero=$((zero + 1))
    echo "  ZERO-TOUCH #$number ($total_commits commits) $title"
  else
    human=$((human + 1))
  fi
done
echo ""
echo "TOTAL MERGED: $total | ZERO-TOUCH: $zero | HUMAN-TOUCH: $human"
if [ "$total" -gt 0 ]; then
  rate=$((zero * 100 / total))
  echo "6-GREEN RATE: ${rate}% ($zero/$total zero-touch)"
fi
```

### Step 4: Output diagnostic report

```
## Autonomy Diagnostic — <date>

### System health
- AO lifecycle-worker: RUNNING / STOPPED (count: N)
- Orchestrator session: SPAWNING / IDLE / STUCK / NOT FOUND
- Active worker sessions: N (M working, K idle, J completed)
- Rate limits: core=N, graphql=N
- Open PRs: N total, N non-green

### Orchestrator state
<What the orchestrator is doing based on tmux capture>

### Per-PR status
| PR | Non-green reason | Session | Session state | Activity |
|---|---|---|---|---|
| #NNN | <reason> | ao-NNN / none | WORKING/IDLE/COMPLETED/QUEUED | <indicator or "—"> |

### CHANGES_REQUESTED gaps
<List PRs with CR CHANGES_REQUESTED that have NO active session>
(If none, say "All CR_REQ PRs have active sessions")

### Stalled PRs (>1hr gap, not 6-green)
| PR | Gap | Review state | Mergeable | Worker | Title |
|---|---|---|---|---|---|
<List each stalled PR. If worker=no, this is a coverage gap requiring ao spawn.>
(If none, say "No stalled PRs")

### Zombie session check
<Sessions where AO status=killed but tmux still alive>
| Session | AO status | tmux alive | PR | Action needed |
(If none, say "No zombie sessions")

### AO session store vs tmux desync
<"ao session ls" result vs tmux count — flag desync>

### Lifecycle-worker duplicate check
<Count per project — only flag if SAME PROJECT has >1 worker>

### 6-Green Rate (last 7 days)
| Metric | Value |
|---|---|
| Total merged | N |
| Zero-touch (all [agento] commits) | N (NN%) |
| Human-touch (had human commits) | N (NN%) |
<List zero-touch PRs by number>

### Root cause
<Primary reason the system is not progressing PRs autonomously>

### Recommended fix
<Concrete next step>
```

## Input

$ARGUMENTS
