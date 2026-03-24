# Antigravity Orchestrator — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Author:** jleechan (brainstormed with Claude Code)
**Epic:** bd-5kp
**Branch:** feat/runtime-antigravity
**PR:** Single PR for full feature

---

## Overview

The Antigravity Orchestrator lets you programmatically control the Antigravity IDE (Google's AI-first VS Code fork) via AO's existing plugin model. Instead of spawning tmux+claude-code sessions, AO spawns Antigravity conversations — each running Gemini/Opus autonomously once started.

**Goal:** Use Antigravity's IDE quota to do arbitrary coding work (design docs, code, PRs) across multiple repos, triggered from Slack, MCP tool calls, or CLI — with full visibility and control over all active workspaces × conversations.

---

## Architecture

```
ao spawn --runtime antigravity
        │
        ▼
┌─────────────────────────────┐
│  runtime-antigravity plugin │  TypeScript, implements Runtime interface
│  (packages/plugins/...)     │
├─────────────────────────────┤
│  Serial Queue (p-queue=1)   │  All Peekaboo ops serialized
├─────────────────────────────┤
│  Shell Executor             │  Calls scripts/antigravity/*.sh
├─────────────────────────────┤
│  scripts/antigravity/       │  Bash scripts wrapping peekaboo CLI
├─────────────────────────────┤
│  Peekaboo                   │  macOS accessibility API
├─────────────────────────────┤
│  Antigravity IDE            │  Runs Gemini/Opus autonomously
└─────────────────────────────┘
```

### Key Constraint

All Peekaboo UI operations are **serialized through a single queue** (concurrency=1). Antigravity's accessibility tree is global — concurrent clicks/pastes would race. The queue lives in the TypeScript plugin, not in the shell scripts.

### Fallback Chain

If a shell script fails (exit code != 0 or "element not found" in output):
1. Log the failure + context
2. Fall back to `claude --dangerously-skip-permissions` with equivalent task
3. Record fallback in session metadata

### Capacity-Out Handling

If Antigravity/Gemini returns a capacity error:
1. Parse the "retry after" time from the UI (if visible)
2. Mark session as `capacity-wait` with expected retry time
3. Loop skips this session until retry time passes
4. If no retry time parseable, exponential backoff (5m, 10m, 20m, cap 60m)

---

## Decisions Log (from brainstorming 2026-03-24)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Exit criteria | B (multi-repo live demo), then loop 20x for C (fallback) | Proves real multi-workspace capability |
| Loop mechanism | launchd daemon, 5min cycles | Survives 8hr unattended runs, reboots |
| Loop strategy | Observe-Evaluate-Steer (tight control) | Catch errors early, steer Gemini |
| Prompt strategy | Hybrid — paste Runtime interface, let Gemini read the rest | Contract too critical to risk misread |
| Worktree strategy | Sub-branches per phase, merge during eval | Parallel convos without conflicts |
| PR strategy | Single PR (feat/runtime-antigravity) | All phases merge into one feature branch |
| Model | Opus 4.6 (as configured in Antigravity) | User preference |
| Capacity handling | Parse retry time, exponential backoff, part of daemon | Graceful degradation |
| Self-healing | Convo restart, Antigravity relaunch, state rebuild, launchd KeepAlive | 8hr unattended durability |

---

## Components

### 1. Shell Executor Scripts (`scripts/antigravity/`)

```
scripts/antigravity/
  lib.sh      — shared: get MANAGER_ID, find workspace element, error handling
  start.sh    — open workspace, start conversation, paste prompt, send
  status.sh   — check if conversation is running/idle/unknown, return JSON
  kill.sh     — navigate to conversation, cancel
  send.sh     — paste follow-up message to open conversation
```

Reference: `~/.claude/skills/antigravity-computer-use/SKILL.md`

### 2. `runtime-antigravity` Plugin (`packages/plugins/runtime-antigravity/`)

```
packages/plugins/runtime-antigravity/
  package.json
  tsconfig.json
  src/
    index.ts        — export AntigravityRuntime class, manifest
    runtime.ts      — implements Runtime interface (create, destroy, sendMessage, getOutput, isAlive, getMetrics, getAttachInfo)
    queue.ts        — serial async executor (p-queue, concurrency: 1)
    executor.ts     — calls scripts/antigravity/*.sh, captures output, handles fallback
    types.ts        — AntigravitySession, AntigravityConfig
  src/__tests__/
    queue.test.ts
    executor.test.ts
    index.test.ts
```

Mirrors structure from `packages/plugins/runtime-tmux/`.
Implements: `Runtime` interface from `packages/core/src/types.ts`.

### 3. Idle Poller (15s interval)

- `status.sh` returns JSON: `{"state": "running"|"idle"|"unknown", "conversation": "<title>"}`
- Runtime polls every 15s, emits `session:idle` event when spinner gone
- Integrates with existing `poller-github-pr` for PR-based completion signal
- On completion: fires AO notifier chain (Slack DM by default)

### 4. Claude Code CLI Fallback

- `executor.ts` catches shell failures (exit code ≠ 0, "element not found" in output)
- Falls back to: `claude --dangerously-skip-permissions` with skill context
- Fallback is logged, reported in session metadata
- Other CLIs (codex, gemini) extensible via config

### 5. MCP Server Tools

| Tool | Args | Description |
|------|------|-------------|
| `antigravity_spawn` | `task, repo, model?, mode?` | Start new conversation in new worktree |
| `antigravity_status` | — | List all active/idle conversations |
| `antigravity_kill` | `session_id` | Cancel running conversation |
| `antigravity_send` | `session_id, message` | Send follow-up to conversation |
| `antigravity_workspaces` | — | List all Antigravity windows/workspaces |

### 6. Config + Multi-Repo

```yaml
projects:
  ao:
    runtime: antigravity
    path: ~/project_agento/agent-orchestrator
    worktreeDir: ~/.worktrees/antigravity/ao

  jleechanclaw:
    runtime: antigravity
    path: ~/.openclaw
    worktreeDir: ~/.worktrees/antigravity/jlc

  worldarchitect:
    runtime: antigravity
    path: ~/projects/worldarchitect.ai
    worktreeDir: ~/.worktrees/antigravity/wa
```

### 7. Entry Points

- **CLI:** `ao spawn --runtime antigravity --repo ao "write design for X"`
- **Slack:** parse `antigravity: <task> in repo: <name>` in #ai-general or DM
- **MCP:** `antigravity_spawn(...)` directly from Claude sessions

---

## Orchestration Loop (launchd Daemon)

A **launchd plist** runs every 5 minutes. Each cycle spawns a short-lived `claude --dangerously-skip-permissions` invocation with a self-contained prompt file.

### Cycle Logic

```
1. Acquire PID lock (skip if another cycle running)
2. Read state file (~/.antigravity-loop/state.json)
3. For each active convo:
   a. peekaboo see → check status (running/idle/capacity-out/error)
   b. If running → skip (let it cook)
   c. If capacity-out → parse retry time, update state, skip
   d. If idle → evaluate output:
      - git diff in the convo's worktree
      - Does it compile? (pnpm build in worktree)
      - Does it match the phase spec?
   e. If output good → commit/push to sub-branch, update state
   f. If output needs fixes → send correction via peekaboo
   g. If phase complete → merge sub-branch into feat/runtime-antigravity
4. For pending phases with no blockers:
   - Create worktree, reset to origin/main
   - Spawn new Antigravity convo with hybrid prompt
   - Record convo ID in state
5. Check overall exit criteria
6. Write updated state file
7. Release PID lock
```

### State File

```json
{
  "startedAt": "2026-03-24T10:00:00Z",
  "phases": {
    "bd-5kp.2": {"status": "in-progress", "convoId": "...", "subBranch": "feat/runtime-antigravity/scripts", "worktree": "..."},
    "bd-5kp.1": {"status": "pending"}
  },
  "exitB": {"passed": false, "attempts": 0},
  "exitC": {"passed": false, "attempts": 0, "maxAttempts": 20},
  "lastCycleAt": "...",
  "capacityWait": {"until": null, "backoffMin": 5}
}
```

### Self-Healing

| Failure | Recovery |
|---------|----------|
| Convo dies/errors | Daemon detects idle/missing → restarts phase convo |
| Daemon crashes | launchd `KeepAlive` restarts it |
| Antigravity crashes | Cycle runs `open -a Antigravity`, waits 10s, retries |
| state.json corrupted | Cycle detects invalid JSON, rebuilds from git branch state |
| Peekaboo hangs | 15min hard timeout kills cycle, next one starts clean |
| Model capacity out | Parse retry time from UI, exponential backoff |

### Daemon Files

```
~/.antigravity-loop/
  state.json                            # Persisted state across cycles
  cycle-prompt.md                       # Self-contained prompt for each cycle
  cycle.sh                             # Wrapper with PID lock + timeout
  com.jleechan.antigravity-loop.plist   # launchd plist
  logs/                                 # Per-cycle output logs
```

### Anti-Clobber (PID Lock)

```bash
LOCKFILE=~/.antigravity-loop/cycle.lock
if [ -f "$LOCKFILE" ]; then
  PID=$(cat "$LOCKFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "cycle already running (PID $PID), skipping"
    exit 0
  fi
  rm "$LOCKFILE"  # stale lock from crash
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT
```

Hard timeout via launchd `<key>TimeOut</key><integer>900</integer>` (15 min).

---

## Concurrency Model

```
Peekaboo serial queue (single-threaded):
  t=0  start conv A (repo: ao)          → 3s
  t=3  start conv B (repo: jlc)         → 3s
  t=6  start conv C (repo: wa)          → 3s
  t=9  check status conv A              → 1s
  ...

Antigravity conversations (parallel, autonomous after start):
  Conv A ═══════════════════════════════════════════▶ done
  Conv B     ═══════════════════════════════════════▶ done
  Conv C          ══════════════════════════════════▶ done
```

Queue priority: `kill` > `status` > `send` > `spawn`

---

## Exit Criteria

### Exit B — Multi-Repo Live Demo (REQUIRED GATE)

All must be true simultaneously:
1. `ao spawn --runtime antigravity --project ao "add a README"` → Antigravity convo opens, Gemini starts coding
2. Same for a second repo → second convo running in parallel
3. Both convos complete autonomously → `ao session ls` shows both idle
4. Both pushed to sub-branches → git log shows Gemini commits
5. AO poller detected idle → Slack notification fired for both
6. `ao send <session> "add a LICENSE"` → convo resumes
7. `ao kill <session>` → convo terminated, session cleaned up
8. `pnpm build && pnpm test && pnpm typecheck` all pass

### Exit C — Fallback Path (UP TO 20 ATTEMPTS)

1. Simulate Peekaboo failure (kill Antigravity or rename peekaboo binary)
2. `ao spawn --runtime antigravity` detects failure
3. Falls back to `claude --dangerously-skip-permissions` automatically
4. Fallback session completes the task
5. Session metadata records `"fallback": "claude-code"`
6. Restore Antigravity, verify normal path works again

### Stop Conditions

| Condition | Action |
|-----------|--------|
| Exit B + Exit C pass | SUCCESS — stop daemon, Slack notify |
| Exit B pass + 20 C attempts exhausted | PARTIAL SUCCESS — stop, Slack with details |
| 8 hours elapsed | TIMEOUT — stop, Slack with current state |
| Fatal error | ABORT — stop, Slack with error |

---

## Implementation Order (Beads)

| Phase | Bead | Description | Depends On |
|-------|------|-------------|------------|
| 1 | bd-5kp.2 | Shell executor scripts | — |
| 2 | bd-5kp.1 | TypeScript plugin skeleton | bd-5kp.2 |
| 3 | bd-5kp.6 | Idle poller (15s) | bd-5kp.1 |
| 4 | bd-5kp.3 | Claude Code CLI fallback | bd-5kp.1 |
| 5 | bd-5kp.4 | MCP tools | bd-5kp.1 |
| 6 | bd-5kp.5 | agent-orchestrator.yaml config | bd-5kp.1 |
| 7 | bd-5kp.7 | Slack + CLI entry points | bd-5kp.4, bd-5kp.5 |

Phases 3-6 can run in parallel once Phase 2 completes.

### Worktree Strategy

Each phase gets its own sub-branch:
- `feat/runtime-antigravity/scripts` (bd-5kp.2)
- `feat/runtime-antigravity/plugin` (bd-5kp.1)
- `feat/runtime-antigravity/poller` (bd-5kp.6)
- `feat/runtime-antigravity/fallback` (bd-5kp.3)
- `feat/runtime-antigravity/mcp` (bd-5kp.4)
- `feat/runtime-antigravity/config` (bd-5kp.5)
- `feat/runtime-antigravity/entrypoints` (bd-5kp.7)

Merged into `feat/runtime-antigravity` during daemon evaluate step.

### Phase Prompts (Hybrid Strategy)

Each Antigravity convo prompt includes:
1. **Pasted:** Runtime interface + types (RuntimeCreateConfig, RuntimeHandle, RuntimeMetrics, AttachInfo)
2. **Pasted:** Phase-specific section from this doc
3. **Read directive:** "Read packages/plugins/runtime-tmux/src/index.ts as your template"
4. **Read directive:** "Read docs/design/ANTIGRAVITY_ROADMAP.md for full context"
5. **Rules:** TDD, TypeScript strict, conventional commits, files <300 LOC
6. **Worktree:** "Create a git worktree, reset to origin/main, work on branch feat/runtime-antigravity/<phase>"

---

## Error Handling

| Failure | Recovery |
|---------|----------|
| Peekaboo element not found | Retry 3x with re-snapshot; fallback to Claude Code CLI |
| "Allow this conversation" dialog | Always click Allow (pre-authorized) |
| Antigravity not running | `open -a Antigravity`, retry after 10s |
| Gemini rate limit (in-IDE) | Log warning, capacity-wait with backoff |
| Worktree already exists | Reuse if clean, error if dirty |
| Claude Code CLI fallback fails | Mark session `failed`, notify via Slack |

---

## What's NOT in scope (v1)

- Multi-machine (Peekaboo is macOS-local only)
- Concurrent Peekaboo ops (fundamental macOS limitation)
- Antigravity browser panel automation
- Artifact/walkthrough parsing (only PR and idle detection)
- Auto-merge (handled by existing AO auto-merge pipeline)

---

## Reference

| Resource | Path |
|----------|------|
| Antigravity skill | `~/.claude/skills/antigravity-computer-use/SKILL.md` |
| Runtime interface | `packages/core/src/types.ts` (Runtime, RuntimeCreateConfig, RuntimeHandle) |
| Existing runtime | `packages/plugins/runtime-tmux/src/index.ts` |
| Roadmap | `docs/design/ANTIGRAVITY_ROADMAP.md` |
| Epic bead | bd-5kp |
