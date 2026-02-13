# CLAUDE.md — Agent Orchestrator

## What This Project Is

An open-source, agent-agnostic system for orchestrating parallel AI coding agents. Any coding agent, any repo, any issue tracker, any runtime. The system manages session lifecycle, tracks PR/CI/review state, auto-handles routine issues (CI failures, review comments), and pushes notifications to humans only when their judgment is needed.

**Core principle: Push, not pull.** The human spawns agents, walks away, and gets notified when needed.

## Tech Stack

- **Language**: TypeScript throughout (ESM, Node 20+)
- **Monorepo**: pnpm workspaces
- **Web**: Next.js 15 (App Router) + Tailwind CSS
- **CLI**: Commander.js
- **Config**: YAML + Zod validation
- **Real-time**: Server-Sent Events
- **State**: Flat metadata files + JSONL event log

## Architecture

8 plugin slots — every abstraction is swappable:

| Slot | Interface | Default Plugin |
|------|-----------|---------------|
| Runtime | `Runtime` | tmux |
| Agent | `Agent` | claude-code |
| Workspace | `Workspace` | worktree |
| Tracker | `Tracker` | github |
| SCM | `SCM` | github |
| Notifier | `Notifier` | desktop |
| Terminal | `Terminal` | iterm2 |
| Lifecycle | (core, not pluggable) | — |

All interfaces are defined in `packages/core/src/types.ts`. **Read this file first** — it is the source of truth for all abstractions.

## Directory Structure

```
packages/
  core/          — @agent-orchestrator/core (types, config, services)
  cli/           — @agent-orchestrator/cli (the `ao` command)
  web/           — @agent-orchestrator/web (Next.js dashboard)
  plugins/
    runtime-tmux/       — tmux session runtime
    runtime-process/    — child process runtime
    agent-claude-code/  — Claude Code adapter
    agent-codex/        — Codex CLI adapter
    agent-aider/        — Aider adapter
    workspace-worktree/ — git worktree isolation
    workspace-clone/    — git clone isolation
    tracker-github/     — GitHub Issues tracker
    tracker-linear/     — Linear tracker
    scm-github/         — GitHub PRs, CI, reviews
    notifier-desktop/   — OS desktop notifications
    notifier-slack/     — Slack notifications
    notifier-webhook/   — Generic webhook notifications
    terminal-iterm2/    — macOS iTerm2 tab management
    terminal-web/       — xterm.js web terminal
```

## Conventions

### TypeScript
- ESM modules (`"type": "module"`)
- Use `.js` extensions in imports (TypeScript ESM requirement): `import { foo } from "./bar.js"`
- Strict mode enabled
- Use `node:` prefix for Node.js builtins: `import { readFileSync } from "node:fs"`

### Plugin Structure
Every plugin exports a `PluginModule`:
```typescript
import type { PluginModule, Runtime } from "@agent-orchestrator/core";

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "tmux",
    // ... implement interface
  };
}
```

### Shell Commands
When a plugin needs to run shell commands (git, tmux, gh, etc.), use `child_process.execFile` or `child_process.spawn` from `node:child_process`. Wrap them in async helpers.

### Error Handling
- Throw typed errors, don't return error codes
- Plugin methods should throw if they can't do their job
- The core services catch and handle plugin errors

### Config
- Config is loaded from `agent-orchestrator.yaml` (see `.yaml.example`)
- All paths support `~` expansion
- Per-project overrides for plugins and reactions

## Reference Implementation

The `scripts/` directory contains the original bash scripts that this TypeScript codebase replaces. Use them as specifications:

| Script | What It Specifies |
|--------|------------------|
| `claude-ao-session` | Session lifecycle (spawn, list, kill, cleanup) |
| `claude-dashboard` | Web dashboard, API, activity detection |
| `claude-batch-spawn` | Batch spawning with duplicate detection |
| `send-to-session` | Smart message delivery (busy detection, wait-for-idle) |
| `claude-status` | JSONL introspection, live branch detection |
| `claude-review-check` | PR review scanning, fix prompt generation |
| `claude-bugbot-fix` | Automated comment detection + fixes |
| `claude-session-status` | Activity classification (working/idle/blocked) |
| `get-claude-session-info` | Agent introspection (session ID, summary extraction) |

## Building

```bash
pnpm install
pnpm build          # build all packages
pnpm typecheck      # typecheck all packages
```

## Key Design Decisions

1. **Stateless orchestrator** — no database, just flat metadata files + event log
2. **Plugins implement interfaces** — every plugin is a pure implementation of an interface from `types.ts`
3. **Push notifications** — the Notifier is the primary human interface, not the dashboard
4. **Two-tier event handling** — auto-handle routine issues (CI, reviews), notify human only when judgment is needed
5. **Backwards-compatible metadata** — flat key=value files matching the existing bash script format
