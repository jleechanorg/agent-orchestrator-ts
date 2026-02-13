# CLAUDE.local.md - Agent Orchestrator Development

You are working on **agent-orchestrator**, an open-source multi-agent orchestrator for Claude Code. This tool manages parallel coding agents across projects from a single control plane.

> **Dog-fooding**: This orchestrator is being built using a copy of itself. The `~/` home directory orchestrator manages sessions that work on this very repo.

## Project Overview

Agent Orchestrator lets you:
- Spawn and manage dozens of Claude Code agents working in parallel
- Track progress via a live HTML dashboard with PR status, CI checks, and merge actions
- Send commands to agents, kill/cleanup sessions, and view terminals in-browser
- Organize agents by project with worktree-based isolation

## Repo Structure

```
agent-orchestrator/
├── scripts/               # Core orchestrator scripts
│   ├── claude-status              # Unified dashboard (CLI)
│   ├── claude-batch-spawn         # Spawn multiple sessions at once
│   ├── claude-spawn               # Spawn single session in new terminal tab
│   ├── claude-dashboard           # HTML dashboard with live PR status (web UI)
│   ├── claude-open-all            # Open terminal tabs for all sessions
│   ├── claude-review-check        # Trigger agents to address PR review comments
│   ├── claude-bugbot-fix          # Fix bugbot comments across sessions
│   ├── claude-session-status      # Health monitor (working/idle/blocked/waiting)
│   ├── claude-spawn-with-context  # Spawn with custom prompt file
│   ├── claude-spawn-on-branch     # Spawn on existing branch
│   ├── claude-spawn-with-prompt   # Spawn and deliver prompt after ready
│   ├── get-claude-session-info    # Extract session metadata from tmux
│   ├── open-tmux-session          # Switch to terminal tab for tmux session
│   ├── open-iterm-tab             # iTerm2 tab management
│   ├── notify-session             # iTerm2 notifications from sessions
│   ├── send-to-session            # Smart message delivery to tmux sessions
│   ├── claude-integrator-session  # Example: project session manager (Linear/integrator)
│   └── claude-splitly-session     # Example: project session manager (GitHub Issues/SafeSplit)
├── CLAUDE.local.md        # This file (dev instructions)
├── CLAUDE.md              # Repo-level instructions for contributors
└── README.md              # Project README
```

## Current State

The scripts in `scripts/` are direct copies from the production orchestrator (`~/`). They currently have hardcoded paths and project-specific references (integrator, splitly). The work ahead is to:

1. **Generalize** — Remove hardcoded project names, make scripts project-agnostic
2. **Configuration** — Add a config file (e.g., `orchestrator.yaml`) that defines projects, repos, branches, issue trackers
3. **Installation** — Create an install script that symlinks scripts to `~/` or adds them to PATH
4. **Documentation** — Write a comprehensive README with setup guide and examples
5. **Self-hosting** — Make this repo use its own orchestrator for development

## Project Info

- **Repo**: ComposioHQ/agent-orchestrator (GitHub)
- **Issue Tracker**: Linear
- **Visibility**: Internal (ComposioHQ org)
- **Everything runs locally** — no Datadog, no cloud infra

## Development Workflow

```bash
# This repo is managed by the home directory orchestrator
# Sessions are spawned via:
~/claude-spawn-with-context i TICKET /tmp/prompt.txt --open

# Linear tickets for this project
# (use Rube MCP LINEAR_CREATE_LINEAR_ISSUE to create tickets)

# GitHub issues (secondary):
gh issue list --repo ComposioHQ/agent-orchestrator --state open
```

## Key Design Principles

1. **tmux-based** — All agent sessions run in tmux. This gives persistence, detach/attach, and scriptability.
2. **Metadata files** — Each session has a flat metadata file (`key=value` format) tracking branch, PR, issue, status, notes.
3. **Live dashboard** — HTML dashboard served locally with real-time activity detection via Claude's JSONL session files.
4. **Project-agnostic shared scripts** — Core scripts (spawn, status, dashboard) take project as an argument.
5. **Project-specific session managers** — Each project gets a session manager script that handles worktrees, naming, and cleanup.
6. **iTerm2 integration** — AppleScript-based tab management for macOS (should be made terminal-agnostic).

## Architecture Notes

### Session Lifecycle
```
spawn → tmux session created → Claude started → working on issue
  ↓
metadata file written (branch, issue, status)
  ↓
agent creates PR → metadata updated (pr=URL)
  ↓
dashboard shows PR status, CI, review state
  ↓
PR merged → cleanup kills session, archives metadata
```

### Activity Detection
The dashboard detects if agents are working/idle/exited by:
1. Checking Claude's JSONL session file modification time and last message type
2. Walking the process tree from tmux pane PID to find `claude` processes
3. Polling every 5 seconds via `/api/sessions` endpoint

### Dashboard Server
- Python HTTP server serving static HTML + JSON API
- `/api/sessions` — live activity status
- `/api/terminal/:name` — spawn ttyd web terminal for session
- `/api/kill/:name` — kill session + close iTerm tab + archive metadata
- `/api/merge/:repo/:num` — merge PR via `gh`
- `/api/send/:name` — send message to agent via `send-to-session`
