<h1 align="center">Agent Orchestrator — AO Fork</h1>

> **⚠️ This is a fork.** The canonical upstream is
> [**ComposioHQ/agent-orchestrator**](https://github.com/ComposioHQ/agent-orchestrator).
> This fork runs independently and may have diverged. PRs from upstream are regularly
> cherry-picked; fork changes can be proposed upstream via PR.</p>

<p align="center">
<a href="https://platform.composio.dev/?utm_source=Github&utm_medium=Banner&utm_content=AgentOrchestrator">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</a>
</p>

### This Fork vs Upstream

This fork adds **agentic CI infrastructure** on top of the upstream agent-orchestrator. The upstream is a standard CI repo; this fork is an autonomous coding pipeline where AO workers drive PRs to merge with zero operator intervention.

| Feature | ComposioHQ/agent-orchestrator | jleechanorg/agent-orchestrator (this fork) |
|---------|-------------------------------|------------------------------------------|
| Auto-merge | ⚠️ Config flag (`auto: true`), manual ops | ✅ AO orchestrator + evolve loop, zero-touch metrics |
| Skeptic agent | ❌ None | ✅ 7th merge gate (independent LLM verifier, local keys) |
| Evidence Gate | ❌ None | ✅ CI validates PR evidence bundle + claim class |
| CodeRabbit reviews | ❌ None | ✅ Per-PR reviews on every PR |
| Cursor Bugbot | ⚠️ Skipped | ✅ Runs on every PR |
| Session recovery | ✅ recovery/ scanner + manager | ✅ + stalled-worker-auditor, no-delta-watchdog |
| Spawn queue | ❌ None | ✅ File-backed admission control, 20-session cap, 30s drain, per-project queues |
| Pollers | ❌ None | ✅ GitHub PR poller + respawn cap (prevent spam), extensible for trackers |
| OpenClaw notifier | ❌ None | ✅ Wired for Slack notifications |
| Beads issue tracker | ❌ None | ✅ SQLite-based local tracker plugin |
| llm_inspector | ❌ None | ✅ Context overhead analysis + lean mode (-20K tokens/turn) |
| Self-hosted runners | ❌ | ✅ |
| Node.js requirement | 20+ | 22+ |
| CI jobs | lint, typecheck, test, test-web | same + evidence-gate, skeptic-gate |
| GitHub workflows | 7 | 13 (+coderabbit-ping, cr-loop-health, evidence-gate, skeptic-cron, skeptic-gate, wholesome-checks) |
| Core TS files | ~63 | ~158 (~2.5× test coverage) |

This fork's goal is **fully autonomous, zero-touch PR merging** for its own codebase. The upstream goal is a general-purpose orchestration tool.

**Evidence standards** (artifacts, reviewer checklist, `/er` vs CI vs Skeptic): see **`docs/evidence/README.md`**.

<div align="center">

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise from one dashboard.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/UZv7JjxbwG)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Cursor, Gemini, Aider, OpenCode, MiniMax) · **Runtime-agnostic** (tmux, process, Antigravity) · **Tracker-agnostic** (GitHub, GitLab, Linear, Beads)

<div align="center">

## See it in action

<a href="https://x.com/agent_wrapper/status/2026329204405723180">
  <img src="docs/assets/demo-video-tweet.png" alt="Agent Orchestrator demo — AI agents building their own orchestrator" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="docs/assets/btn-watch-demo.png" alt="Watch the Demo on X" height="48"></a>
<br><br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945">
  <img src="docs/assets/article-tweet.png" alt="The Self-Improving AI System That Built Itself" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945"><img src="docs/assets/btn-read-article.png" alt="Read the Full Article on X" height="48"></a>

</div>

## Quick Start

> **Prerequisites:** [Node.js 22+](https://nodejs.org), [Git 2.25+](https://git-scm.com), [tmux](https://github.com/tmux/tmux/wiki/Installing), [`gh` CLI](https://cli.github.com). Install tmux via `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

### Install

```bash
npm install -g @jleechanorg/ao-cli
```

<details>
<summary>Permission denied? Install from source?</summary>

If `npm install -g` fails with EACCES, prefix with `sudo` or [fix your npm permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

To install from source (for contributors):

```bash
git clone https://github.com/jleechanorg/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
```
</details>

### Start

Point it at any repo — it clones, configures, and launches the dashboard in one command:

```bash
ao start https://github.com/your-org/your-repo
```

Or from inside an existing local repo:

```bash
cd ~/your-project && ao start
```

That's it. The dashboard opens at `http://localhost:3000` and the orchestrator agent starts managing your project.

### Add more projects

```bash
ao start ~/path/to/another-repo
```

## How It Works

1. **You start** — `ao start` launches the dashboard and an orchestrator agent
2. **Orchestrator spawns workers** — each issue gets its own agent in an isolated git worktree
3. **Agents work autonomously** — they read code, write tests, create PRs
4. **Reactions handle feedback** — CI failures and review comments are automatically routed back to the agent
5. **You review and merge** — you only get pulled in when human judgment is needed

The orchestrator agent uses the [AO CLI](docs/CLI.md) internally to manage sessions. You don't need to learn or use the CLI — the dashboard and orchestrator handle everything.

## jleechanorg Fork: OpenClaw Integration

This fork is used as the execution layer for `jleechanorg/jleechanclaw`.

> Note: This README defaults to the `jleechanorg/agent-orchestrator` fork clone URL.
> If you specifically want upstream, use
> [`ComposioHQ/agent-orchestrator`](https://github.com/ComposioHQ/agent-orchestrator).

Typical split of responsibilities:
- `jleechanorg/jleechanclaw` (OpenClaw harness): user intent parsing, context expansion, policy, and status updates.
- `jleechanorg/agent-orchestrator`: worker session lifecycle, isolated worktrees, PR execution loops, CI/review remediation.

Key integration points in this repo:
- Plugin contracts: `packages/core/src/types.ts`
- OpenClaw notifier plugin: `packages/plugins/notifier-openclaw/src/index.ts`
- GitHub SCM plugin: `packages/plugins/scm-github/src/index.ts`
- tmux runtime plugin: `packages/plugins/runtime-tmux/src/index.ts`

Example notifier wiring (`agent-orchestrator.yaml`) — `openclaw` is also listed in the supported notifier options table below:

```yaml
defaults:
  notifiers: [desktop, openclaw]

notifiers:
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: ${OPENCLAW_HOOKS_TOKEN}
```

## Configuration

`ao start` auto-generates `agent-orchestrator.yaml` with sensible defaults. You can edit it afterwards to customize behavior:

```yaml
# agent-orchestrator.yaml
port: 3000

defaults:
  runtime: tmux
  agent: cursor
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false # flip to true for auto-merge
    action: notify
```

CI fails → agent gets the logs and fixes it. Reviewer requests changes → agent addresses them. PR approved with green CI → you get a notification to merge.

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference, or run `ao config-help` for the complete schema.

## Plugin Architecture

Eight slots. Every abstraction is swappable.

| Slot      | Default     | Alternatives                 |
| --------- | ----------- | ---------------------------- |
| Runtime   | tmux        | process, antigravity *(fork)* |
| Agent     | claude-code | codex, cursor, gemini, aider, opencode, minimax *(fork)* |
| Workspace | worktree    | clone                        |
| Tracker   | github      | gitlab, linear, beads *(fork)* |
| SCM       | github      | gitlab                       |
| Notifier  | desktop     | slack, composio, webhook, openclaw, mcp-mail *(fork)* |
| Terminal  | iterm2      | web                          |
| Lifecycle | core        | —                            |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents, check if they're stuck, read CI failures, forward review comments, track which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao start` and walk away. The system handles isolation, feedback routing, and status tracking. You review PRs and make decisions — the rest is automated.


## Context Overhead Tooling (Fork-Only)

The [`docs/llm_inspector.md`](docs/llm_inspector.md) guide covers the capture proxy, `--tool-mode lean` (strips 17 heavy built-in tools, ~20K tokens/turn), and `--tool-mode on-demand` (stub + re-issue, ~84.9% reduction on heavy tools).

Install llm_inspector: `curl -fsSL https://raw.githubusercontent.com/jleechanorg/llm_inspector/main/install.sh | bash`

| Overhead source | % of tokens/turn |
|---|---|
| Built-in tool definitions | ~49% |
| System prompt | ~15% |
| MCP tool definitions | ~15% |
| CLAUDE.md / instructions | ~16% |

`--tool-mode lean` removes 17 heavy built-in tools (~20K tokens/turn). On-demand tool profiles via MCP toggle reduce per-turn overhead further for long sessions.

Evidence bundle: [`docs/evidence/on-demand-stub-schema-2026-04-11/`](docs/evidence/on-demand-stub-schema-2026-04-11/) (N=10, mean 84.9% Agent stub reduction, PASS).

## Zero-Touch Policy (Canonical Reference)

For this fork, zero-touch metrics are defined in:
- `docs/zero-touch-by-operator.md` (canonical definition + formulas)

This includes both:
- **zero-touch-by-operator**
- **zero-touch smooth** (requires max inactivity gap `<= 60 minutes` from PR open to merge)

Use this doc as the source of truth for dashboards, scripts, and status reporting.

## Documentation

| Doc                                      | What it covers                                               |
| ---------------------------------------- | ------------------------------------------------------------ |
| [Setup Guide](SETUP.md)                  | Detailed installation, configuration, and troubleshooting    |
| [CLI Reference](docs/CLI.md)             | All `ao` commands (start, stop, spawn, status, etc.)          |
| [Examples](examples/)                    | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [Development Guide](docs/DEVELOPMENT.md) | Architecture, conventions, plugin pattern                    |
| [Contributing](CONTRIBUTING.md)          | How to contribute, build plugins, PR process                 |

## CLI Commands

The `ao` CLI provides these commands:

```bash
ao start [project|url]    # Start orchestrator with project config or clone repo
ao stop                   # Stop running orchestrator
ao spawn <prompt>         # Spawn new agent session (queued if at 20-session cap)
ao status                 # Show session status
ao dashboard              # Open web dashboard
ao config-help            # Show config schema reference
ao doctor                 # Run diagnostics
ao skeptic verify -n <PR> # Run LLM skeptic evaluation on a PR (fork-only)
ao orphan-sweep           # Clean up stale sessions (fork-only)
ao send <session> <msg>   # Send message to running agent (fork-only)
```

Run `ao --help` for full command list.

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests
pnpm dev                       # Start web dashboard dev server
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for code conventions and architecture details.

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. Every plugin is an implementation of a TypeScript interface — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Development Guide](docs/DEVELOPMENT.md) for the pattern.

## License

MIT
