# Antigravity Orchestrator — Design Doc

**Date:** 2026-03-24
**Status:** Draft
**Author:** jleechan (brainstormed with Claude Code)

---

## Overview

The Antigravity Orchestrator lets you programmatically control the Antigravity IDE (Google's AI-first VS Code fork) via AO's existing plugin model. Instead of spawning tmux+claude-code sessions, AO spawns Antigravity conversations — each running Gemini with Google's quota, fully autonomous once started.

**Goal:** Use Antigravity's IDE quota to do arbitrary coding work (design docs, code, PRs) across multiple repos, triggered from Slack, MCP tool calls, or CLI — with full visibility and control over all active workspaces × conversations.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Entry Points                          │
│   Slack message  │  MCP tool call  │  CLI: ao spawn          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              AO Orchestrator (existing, multi-repo)          │
│  workspace-worktree plugin (existing) — git worktree create  │
│  runtime-antigravity plugin (NEW) — Peekaboo executor        │
│  poller-github-pr (existing) — completion detection          │
│  notifier-slack (existing) — DM on completion                │
└──────────────────────────┬───────────────────────────────────┘
                           │ serial Peekaboo queue
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              Antigravity IDE (macOS)                         │
│  Conv A — repo X  (Gemini, autonomous) ──────────────────▶  │
│  Conv B — repo Y  (Gemini, autonomous)      ──────────────▶  │
│  Conv C — repo Z  (Gemini, autonomous)           ─────────▶  │
└──────────────────────────────────────────────────────────────┘
```

**Key constraint:** Peekaboo (macOS accessibility API) is single-threaded — all UI interactions are serialized through a queue. Conversations run in parallel once started; only the *control* operations (start, check status, send message) are serial.

---

## Components

### 1. `runtime-antigravity` plugin (NEW — TypeScript, in `packages/plugins/`)

The core new piece. Implements the AO `Runtime` interface using Peekaboo instead of tmux.

**Responsibilities:**
- Maintain a **serial Peekaboo executor queue** — all macOS UI operations go through this, one at a time
- **Spawn**: open Antigravity workspace for the given worktree path, start new conversation, paste prompt, send
- **Status**: `peekaboo see` the Manager window, detect `progress_activity` (running) vs idle
- **Kill**: navigate to conversation, cancel/close it
- **Send message**: append a follow-up to a running conversation

**Execution tiers:**
1. **Happy path — pure shell**: deterministic Peekaboo bash commands from the `antigravity-computer-use` skill
2. **Fallback — Claude Code CLI**: when happy path fails (unexpected dialog, element not found), spawn `claude --dangerously-skip-permissions` with the skill loaded to navigate adaptively

**Shell executor** (bash module, called by the plugin):
```bash
# Start conversation
MANAGER_ID=$(peekaboo window list --app Antigravity --json | ...)
peekaboo click --app Antigravity --window-id "$MANAGER_ID" --on <WORKSPACE_ELEM>
peekaboo paste --app Antigravity --text "$PROMPT"
peekaboo press return --app Antigravity

# Check status
peekaboo see --app Antigravity --window-id "$MANAGER_ID" --json | \
  python3 -c "...detect progress_activity spinner..."
```

---

### 2. Worktree management — `workspace-worktree` (existing)

No changes needed. AO already creates and cleans up git worktrees per session. The Antigravity runtime opens the worktree path as an Antigravity workspace.

**Worktree location:** `~/.worktrees/antigravity/<repo>/<session-id>/`

---

### 3. Completion detection — `poller-github-pr` (existing) + idle poll

Two signals for "done":
- **Idle signal:** `progress_activity` spinner gone from conversation in Manager sidebar (Gemini finished)
- **PR signal:** `poller-github-pr` detects a new PR opened from the worktree branch (stronger, optional)

The runtime-antigravity plugin polls on its own 15s interval for the idle signal. PR detection reuses the existing poller.

---

### 4. Notifications — `notifier-slack` (existing)

On completion: Slack DM to jleechan with session summary, PR URL if created, worktree path.

---

### 5. MCP server — expose Antigravity tools

Thin MCP wrapper exposing Antigravity-specific tools on top of AO's existing API:

| Tool | Description |
|------|-------------|
| `antigravity_spawn(task, repo, model?, mode?)` | Start new conversation in worktree |
| `antigravity_status()` | List all active/idle conversations with their workspaces |
| `antigravity_send(session_id, message)` | Send follow-up to running conversation |
| `antigravity_kill(session_id)` | Cancel a running conversation |
| `antigravity_workspaces()` | List all Antigravity workspaces (window list) |

---

### 6. Entry points

**Slack:** Message in `#ai-general` or DM: `antigravity: write a design for X in repo: agent-orchestrator`
→ AO's Slack notifier parses and calls `antigravity_spawn`

**CLI:** `ao spawn --runtime antigravity --repo agent-orchestrator "write design for X"`
→ Directly hits AO spawn logic with `runtime: antigravity`

**MCP tool:** Any Claude session calls `antigravity_spawn(...)` as a tool
→ MCP server routes to AO daemon

---

## Multi-repo config

```yaml
# agent-orchestrator.yaml additions
projects:
  agent-orchestrator:
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

Path override: caller can pass `path: /absolute/path` to target any local repo not in the registry.

---

## Antigravity model selection

Per-conversation model can be specified at spawn time:

| Model | Use case |
|-------|----------|
| Gemini 3 Pro (default) | General coding, design docs |
| Gemini 3 Deep Think | Complex architecture, hard bugs |
| Gemini 3 Flash | Fast, simple tasks |
| Claude Opus 4.6 | When Gemini quota exhausted (uses Anthropic quota) |

---

## Concurrency model

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

## Error handling

| Failure | Recovery |
|---------|----------|
| Peekaboo element not found | Retry 3x with re-snapshot; fallback to Claude Code CLI |
| "Allow this conversation" dialog | Always click Allow (pre-authorized, from skill) |
| Antigravity not running | `open -a Antigravity`, retry after 5s |
| Gemini rate limit (in-IDE) | Switch model to Flash; log warning |
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

## Implementation plan (rough order)

1. `packages/plugins/runtime-antigravity/` — TypeScript plugin skeleton implementing AO Runtime interface
2. `scripts/antigravity/` — Peekaboo shell executor (bash, modular functions)
3. Serial queue in the plugin (`p-queue` or simple async mutex)
4. Claude Code CLI fallback path
5. Status poller (15s interval, idle detection)
6. MCP server additions (`antigravity_spawn`, `antigravity_status`, etc.)
7. `agent-orchestrator.yaml` project entries for multi-repo
8. Launchd plist for always-on AO daemon (if not already present)
9. Slack entry point (AO Slack notifier extension)
10. Integration test: spawn → idle → Slack DM

---

## Reference

- Skill: `~/.claude/skills/antigravity-computer-use/SKILL.md`
- Peekaboo docs: `peekaboo --help`
- AO plugin interface: `packages/plugins/agent-base/`
- AO runtime interface: `packages/core/src/session-manager.ts`
- Existing runtime example: `packages/plugins/runtime-tmux/`
