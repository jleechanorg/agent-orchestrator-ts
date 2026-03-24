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
| Loop mechanism | Persistent Claude tmux session, 5min sleep cycles | Matches AO patterns, preserves context across cycles |
| Loop strategy | Observe-Evaluate-Steer (tight control) | Catch errors early, steer Gemini |
| Prompt strategy | Hybrid — paste Runtime interface, let Gemini read the rest | Contract too critical to risk misread |
| Worktree strategy | Sub-branches per phase, merge during eval | Parallel convos without conflicts |
| PR strategy | Single PR (feat/runtime-antigravity) | All phases merge into one feature branch |
| Model | Opus 4.6 (as configured in Antigravity) | User preference |
| Capacity handling | Parse retry time, exponential backoff, part of daemon | Graceful degradation |
| Self-healing | Convo restart, Antigravity relaunch, state rebuild | 8hr unattended durability |
| Execution model | LLM-driven — Claude orchestrator calls peekaboo directly | No shell script wrappers, more adaptive |
| Shell scripts | DROPPED (bd-5kp.2 → wont_do) | LLM-driven approach is more flexible and self-healing |

---

## Components

### 1. `runtime-antigravity` Plugin (`packages/plugins/runtime-antigravity/`)

```
packages/plugins/runtime-antigravity/
  package.json
  tsconfig.json
  src/
    index.ts        — export AntigravityRuntime class, manifest
    runtime.ts      — implements Runtime interface (create, destroy, sendMessage, getOutput, isAlive, getMetrics, getAttachInfo)
    queue.ts        — serial async executor (p-queue, concurrency: 1)
    peekaboo.ts     — typed wrapper around peekaboo CLI calls (see, click, paste, press, window list)
    types.ts        — AntigravitySession, AntigravityConfig
  src/__tests__/
    queue.test.ts
    peekaboo.test.ts
    index.test.ts
```

Mirrors structure from `packages/plugins/runtime-tmux/`.
Implements: `Runtime` interface from `packages/core/src/types.ts`.

**LLM-driven execution:** Instead of shell scripts, the plugin calls peekaboo CLI directly from TypeScript. The `peekaboo.ts` module provides typed wrappers. All peekaboo operations go through the serial queue. When peekaboo fails (element not found, Antigravity not running), the Claude Code CLI fallback fires.

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

## Orchestration Loop (Persistent Claude Session)

A **persistent Claude session in tmux** runs the observe-evaluate-steer loop. This follows the same pattern as all other AO worker sessions — a long-lived `claude --dangerously-skip-permissions` process with full context.

```
tmux: antigravity-orch
  └── claude --dangerously-skip-permissions (persistent)
       └── spawns Antigravity convos via peekaboo
       └── evaluates output, sends corrections
       └── commits/pushes to feat/runtime-antigravity
       └── sleeps 5min between eval cycles
```

### Why Persistent Session (not launchd/cron)

- **Context preservation** — the orchestrator remembers what it did last cycle (no cold-start per cycle)
- **Matches AO patterns** — all AO workers are persistent tmux sessions
- **Simpler** — no PID lock, no state file serialization, no shell wrapper
- **Self-healing** — if the session dies, AO's existing session recovery can restart it

### Cycle Logic (internal loop)

```
loop forever (sleep 5min between cycles):
  1. peekaboo see → check all active Antigravity convos
  2. For each active convo:
     - Running → skip
     - Capacity-out → note retry time, skip
     - Idle → evaluate: git diff, pnpm build, quality check
       - Good → commit/push to sub-branch, mark phase done
       - Needs fixes → send correction via peekaboo
     - Missing/died → restart convo
  3. For pending phases with deps met → spawn new Antigravity convo
  4. Merge completed sub-branches into feat/runtime-antigravity
  5. Check exit criteria (B then C)
  6. If all done → notify Slack, exit
  7. If 8 hours elapsed → notify Slack, exit
```

### Self-Healing

| Failure | Recovery |
|---------|----------|
| Convo dies/errors | Orchestrator detects missing convo → restarts it |
| Orchestrator session dies | Restart: `tmux new-session -d -s antigravity-orch ... && tmux send-keys ...` |
| Antigravity crashes | `open -a Antigravity`, wait 10s, retry |
| Peekaboo fails 3x | Log warning, skip cycle, retry next cycle |
| Model capacity out | Parse retry time from UI, exponential backoff (5m→60m cap) |

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
| ~~1~~ | ~~bd-5kp.2~~ | ~~Shell executor scripts~~ | DROPPED — LLM-driven |
| 1 | bd-5kp.1 | TypeScript plugin skeleton (Runtime + queue + peekaboo.ts) | — |
| 2 | bd-5kp.6 | Idle poller (15s) | bd-5kp.1 |
| 3 | bd-5kp.3 | Claude Code CLI fallback | bd-5kp.1 |
| 4 | bd-5kp.4 | MCP tools | bd-5kp.1 |
| 5 | bd-5kp.5 | agent-orchestrator.yaml config | bd-5kp.1 |
| 6 | bd-5kp.7 | Slack + CLI entry points | bd-5kp.4, bd-5kp.5 |

Phases 2-5 can run in parallel once Phase 1 completes.

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
