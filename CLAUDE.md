# CLAUDE.md — Agent Orchestrator

## What This Project Is

An open-source, agent-agnostic system for orchestrating parallel AI coding agents. Any coding agent, any repo, any issue tracker, any runtime. The system manages session lifecycle, tracks PR/CI/review state, auto-handles routine issues (CI failures, review comments), and pushes notifications to humans only when their judgment is needed.

**Core principle: Push, not pull.** The human spawns agents, walks away, and gets notified when needed.

## Tech Stack

- **Language**: TypeScript throughout (ESM, Node 20+, strict mode)
- **Monorepo**: pnpm workspaces
- **Web**: Next.js 15 (App Router) + Tailwind CSS
- **CLI**: Commander.js
- **Config**: YAML + Zod validation
- **Real-time**: Server-Sent Events
- **State**: Flat metadata files + JSONL event log
- **Linting**: ESLint (flat config) + Prettier
- **Testing**: vitest

## Architecture

8 plugin slots — every abstraction is swappable:

| Slot      | Interface             | Default Plugin |
| --------- | --------------------- | -------------- |
| Runtime   | `Runtime`             | tmux           |
| Agent     | `Agent`               | claude-code    |
| Workspace | `Workspace`           | worktree       |
| Tracker   | `Tracker`             | github         |
| SCM       | `SCM`                 | github         |
| Notifier  | `Notifier`            | desktop        |
| Terminal  | `Terminal`            | iterm2         |
| Lifecycle | (core, not pluggable) | —              |

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

## Code Conventions

### TypeScript (MUST follow)

- **ESM modules** — all packages use `"type": "module"`
- **`.js` extensions in imports** — required for ESM: `import { foo } from "./bar.js"`
- **`node:` prefix for builtins** — `import { readFileSync } from "node:fs"`, never bare `"fs"`
- **Strict mode** — `"strict": true` in all tsconfig
- **`type` imports** — use `import type { Foo }` for type-only imports (enforced by ESLint)
- **No `any`** — use `unknown` and narrow with type guards. `any` is an ESLint error
- **No `as unknown as T` casts** — validate data instead of unsafe casting
- **Prefer `const`** — `let` only when reassignment is needed, never `var`
- **Semicolons** — always use them
- **Double quotes** — for strings (enforced by Prettier)
- **2-space indentation** — (enforced by Prettier)

### Plugin Pattern (MUST follow)

Every plugin exports a `PluginModule` with type-safe `satisfies`:

```typescript
import type { PluginModule, Runtime } from "@agent-orchestrator/core";

const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

function create(): Runtime {
  return {
    name: "tmux",
    // ... implement interface methods
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

**Do NOT** use `const plugin = { ... }; export default plugin;` — always use inline `satisfies` for compile-time type checking.

### Shell Command Execution (MUST follow)

- **Always use `execFile`** (or `spawn`) from `node:child_process` — NEVER `exec`
- `exec` runs through a shell and is vulnerable to injection
- `execFile` passes args as an array, bypassing shell interpretation
- **Always add timeouts** — `{ timeout: 30_000 }` for external commands
- **Escape user-provided values** — never interpolate into command strings
- **Shell escaping**: Do NOT use `JSON.stringify` for shell escaping — it is not a shell escaping function

```typescript
// GOOD
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { timeout: 30_000 });

// BAD — shell injection risk
import { exec } from "node:child_process";
exec(`git checkout ${branchName}`); // branchName could contain ; rm -rf /
```

### Error Handling

- Throw typed errors, don't return error codes
- Plugin methods should throw if they can't do their job
- The core services catch and handle plugin errors
- **Always wrap `JSON.parse`** in try/catch — corrupted metadata should not crash the system
- **Guard external data** — validate types from API/CLI/file inputs before using them

### Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` only for true constants (env vars, regex patterns)
- Plugin names: `kebab-case` matching directory name
- Test files: `*.test.ts` co-located with source, or in `__tests__/` directory

### Imports Order

1. Node builtins (`node:fs`, `node:path`, etc.)
2. External packages (`commander`, `chalk`, `yaml`, etc.)
3. Workspace packages (`@agent-orchestrator/core`)
4. Relative imports (`./foo.js`)

### Testing

- Use **vitest** for all tests
- Mock external dependencies (`child_process`, `fs`, HTTP calls)
- Co-locate test files: `src/foo.test.ts` or `src/__tests__/foo.test.ts`
- Test edge cases: corrupted data, missing files, timeout, concurrent access

## Building & Development

```bash
pnpm install           # install all deps
pnpm build             # build all packages
pnpm typecheck         # typecheck all packages
pnpm lint              # ESLint check
pnpm lint:fix          # ESLint auto-fix
pnpm format            # Prettier format
pnpm format:check      # Prettier check (CI)
pnpm test              # run all tests
```

### Before Committing

Always run lint and typecheck:

```bash
pnpm lint && pnpm typecheck
```

Fix any issues before pushing. CI will reject PRs that fail lint or typecheck.

## Config

- Config is loaded from `agent-orchestrator.yaml` (see `.yaml.example`)
- All paths support `~` expansion
- Per-project overrides for plugins and reactions
- Validated with Zod schema at load time

## Reference Implementation

The `scripts/` directory contains the original bash scripts that this TypeScript codebase replaces. Use them as behavioral specifications:

| Script                    | What It Specifies                                      |
| ------------------------- | ------------------------------------------------------ |
| `claude-ao-session`       | Session lifecycle (spawn, list, kill, cleanup)         |
| `claude-dashboard`        | Web dashboard, API, activity detection                 |
| `claude-batch-spawn`      | Batch spawning with duplicate detection                |
| `send-to-session`         | Smart message delivery (busy detection, wait-for-idle) |
| `claude-status`           | JSONL introspection, live branch detection             |
| `claude-review-check`     | PR review scanning, fix prompt generation              |
| `claude-bugbot-fix`       | Automated comment detection + fixes                    |
| `claude-session-status`   | Activity classification (working/idle/blocked)         |
| `get-claude-session-info` | Agent introspection (session ID, summary extraction)   |

## Key Design Decisions

1. **Stateless orchestrator** — no database, just flat metadata files + event log
2. **Plugins implement interfaces** — every plugin is a pure implementation of an interface from `types.ts`
3. **Push notifications** — the Notifier is the primary human interface, not the dashboard
4. **Two-tier event handling** — auto-handle routine issues (CI, reviews), notify human only when judgment is needed
5. **Backwards-compatible metadata** — flat key=value files matching the existing bash script format
6. **Security first** — `execFile` not `exec`, validate all external input, escape strings for target context

## Common Mistakes to Avoid

- Using `exec` instead of `execFile` — security vulnerability
- Using `JSON.stringify` for shell escaping — does not escape `$`, backticks, `$()`
- Missing `.js` extension in local imports — will fail at runtime with ESM
- Using bare `"fs"` instead of `"node:fs"` — inconsistent, may break in edge cases
- Casting with `as unknown as T` — bypasses type safety, crashes on bad data
- `export default plugin` without `satisfies PluginModule<T>` — loses type checking
- Interpolating user input into shell commands, AppleScript, or GraphQL queries
- Forgetting to clean up setInterval/setTimeout on disconnect/destroy
- Using `on("exit")` instead of `once("exit")` for one-time handlers
