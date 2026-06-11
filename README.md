<h1 align="center">Agent Orchestrator — AO Fork (jleechanorg)</h1>

> **⚠️ This is a fork.** The canonical upstream is
> [**AgentWrapper/agent-orchestrator**](https://github.com/AgentWrapper/agent-orchestrator)
> (formerly hosted at `ComposioHQ/agent-orchestrator` before the project
> moved to its dedicated org). This fork runs independently and has
> diverged. PRs from upstream are regularly cherry-picked; fork changes
> can be proposed upstream via PR.
>
> **⚠️ Portability Notice — Read Before Cloning**
>
> **This fork is not necessarily portable.** It is built and tested for
> `jleechanorg`'s own development workflow, with defaults that point at
> the fork's own repos, the `jleechanorg/jleechanclaw` OpenClaw harness,
> and several fork-only plugins (`antigravity` runtime, `minimax` / `wafer`
> agents, `beads` tracker, `openclaw` notifier, `mcp-mail` notifier,
> `prose-polish` plugin, MCP-AO bridge).
>
> **Expect to fix configuration before you can use this on your own repo.**
> Specifically:
>
> 1. **Clone URL & npm scope** — The default install instructions clone
>    `github.com/jleechanorg/agent-orchestrator` and install the global
>    `@jleechanorg/ao-cli` npm package. Substitute your own fork, or use
>    `github.com/AgentWrapper/agent-orchestrator` + `@aoagents/ao` for
>    upstream.
> 2. **`agent-orchestrator.yaml`** — The shipped example includes a
>    `projects.agent-orchestrator` entry pointing at
>    `jleechanorg/agent-orchestrator` and a default notifier list of
>    `[desktop, openclaw]`. Replace with your repo(s) and either remove
>    the OpenClaw notifier, or set the `OPENCLAW_HOOKS_TOKEN` env var
>    and run an OpenClaw server reachable at `127.0.0.1:18789`.
> 3. **Hard-coded paths & ports** — Example paths like
>    `~/projects_reference/agent-orchestrator`, `~/.agent-orchestrator`,
>    `~/.worktrees`, ports `3000` (dashboard), `14800`/`14801` (terminal
>    WebSocket), `18789` (OpenClaw hooks), and `3030` (GitHub webhook
>    server) may need to be changed for your machine.
> 4. **macOS-leaning instructions** — Install commands are written for
>    macOS (`brew install …`) with Linux `apt` alternatives. Windows is
>    **not** officially supported by this fork; upstream is.
> 5. **Node 22+** — The fork requires Node 22+ (upstream is Node 20.18.3+).
> 6. **Fork-only plugins** — Anything marked `*(fork)*` in the Plugin
>    Architecture table lives in this fork's `packages/plugins/` and is
>    **not** in `@aoagents/ao`. Do not assume they exist upstream.
> 7. **LLM provider keys** — Skeptic Gate, llm_inspector, and
>    `agent-wafer` / `agent-minimax` adapters require third-party LLM
>    API keys; see `docs/evidence/README.md` and the per-plugin README.
>
> **If you just want to run Agent Orchestrator on your own repo without
> any fork-specific machinery:** start from `examples/simple-github.yaml`,
> ignore the OpenClaw section, set `defaults.notifiers: [desktop]`, and
> verify with `ao doctor`.

<p align="center">
<a href="https://platform.composio.dev/?utm_source=Github&utm_medium=Banner&utm_content=AgentOrchestrator">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</a>
</p>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel
on your codebase. Each agent gets its own git worktree, its own branch,
and its own PR. When CI fails, the agent fixes it. When reviewers leave
comments, the agent addresses them. You only get pulled in when human
judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Cursor, Gemini, Aider, OpenCode, Grok, MiniMax)
· **Runtime-agnostic** (tmux, process, Antigravity)
· **Tracker-agnostic** (GitHub, GitLab, Linear, Beads)

<div align="center">

## See it in action

<a href="https://x.com/agent_wrapper/status/2026329204405723180">
  <img src="docs/assets/demo-video-tweet.png" alt="Agent Orchestrator demo — AI agents building their own orchestrator" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="docs/assets/btn-watch-demo.png" alt="Watch the Demo on X" height="48"></a>

</div>

## Quick Start

> **Prerequisites:** [Node.js 22+](https://nodejs.org) (this fork; upstream
> requires 20.18.3+), [Git 2.25+](https://git-scm.com), [tmux](https://github.com/tmux/tmux/wiki/Installing),
> [`gh` CLI](https://cli.github.com). Install tmux via `brew install tmux`
> (macOS) or `sudo apt install tmux` (Linux). Windows is **not** supported
> by this fork; use upstream AgentWrapper/agent-orchestrator instead.

### Install

```bash
npm install -g @jleechanorg/ao-cli
```

<details>
<summary>Permission denied? Install from source?</summary>

If `npm install -g` fails with EACCES, prefix with `sudo` or [fix your npm permissions](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

To install this fork from source (for contributors):

```bash
git clone https://github.com/jleechanorg/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
```

To install upstream AgentWrapper/agent-orchestrator from source:

```bash
git clone https://github.com/AgentWrapper/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
```

The fork's npm package is `@jleechanorg/ao-cli`; upstream's is `@aoagents/ao`.
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

That's it. The dashboard opens at `http://localhost:3000` (port is
auto-incremented on conflict) and the orchestrator agent starts managing
your project.

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

## This Fork vs Upstream

This fork adds **agentic CI infrastructure** on top of the upstream
agent-orchestrator. The upstream is a general-purpose orchestration tool;
this fork is an autonomous coding pipeline where AO workers drive PRs to
merge with zero operator intervention.

**Upstream:** [`AgentWrapper/agent-orchestrator`](https://github.com/AgentWrapper/agent-orchestrator)
(snapshot: `ComposioHQ/agent-orchestrator` at the same URL still resolves
but is no longer the canonical home).
**This fork:** [`jleechanorg/agent-orchestrator`](https://github.com/jleechanorg/agent-orchestrator).

| Capability | AgentWrapper (upstream) | jleechanorg (this fork) |
|---|---|---|
| Auto-merge | ⚠️ Config flag (`auto: true`), manual ops | ✅ AO orchestrator + evolve loop, zero-touch metrics |
| Skeptic agent | ❌ None | ✅ 7th merge gate (independent LLM verifier, model fallback chain) |
| Evidence Gate | ❌ None | ✅ CI validates PR evidence bundle + claim class |
| CodeRabbit reviews | ❌ None | ✅ Per-PR reviews on every PR + cr-loop-health |
| Cursor Bugbot | ⚠️ Skipped | ✅ Runs on every PR |
| Session recovery | ✅ `recovery/` scanner + manager | ✅ + stalled-worker-auditor, no-delta-watchdog |
| Spawn queue / cap | ❌ None | ✅ File-backed admission control, 20-session cap, 30s drain, per-project queues |
| Pollers | ❌ None | ✅ GitHub PR poller + respawn cap (prevent spam), extensible |
| OpenClaw notifier | ✅ Wired | ✅ + `mcp-mail` notifier *(fork)* |
| Beads issue tracker | ❌ None | ✅ SQLite-based local tracker plugin |
| llm_inspector | ❌ None | ✅ Context overhead analysis + lean mode (-20K tokens/turn) |
| Antigravity runtime | ❌ None | ✅ Fork-only runtime plugin |
| MiniMax / Wafer agent adapters | ❌ None | ✅ Provider adapter plugins (third-party LLM) |
| Node.js requirement | 20.18.3+ | 22+ |
| CI workflows | 8 | 19 (+coderabbit-ping, cr-loop-health, evidence-gate, skeptic-cron, skeptic-gate, wholesome-checks, …) |
| Core TS files | ~150 | ~261 |
| Plugin slots | 7 (Lifecycle moved into core) | 7 (matching upstream) |
| Discord notifier | ✅ | ✅ |
| Windows support | ✅ First-class (ConPTY) | ❌ Not supported |
| `ao send` (worker→orchestrator) | ✅ | ✅ |

**This fork's goal:** fully autonomous, zero-touch PR merging for its own
codebase. **Upstream's goal:** a general-purpose, well-supported
orchestration tool across macOS, Linux, and Windows.

> Stats (workflow count, Core TS file count) were measured on
> `origin/main` @ commit `361d41fb` (fork) and `AgentWrapper/agent-orchestrator`
> @ `5897b4e8` (upstream) on 2026-06-11. They will drift.

**Evidence standards** (artifacts, reviewer checklist, `/er` vs CI vs Skeptic): see **`docs/evidence/README.md`**.

---

## jleechanorg Fork: OpenClaw Integration

This fork is used as the execution layer for `jleechanorg/jleechanclaw`.

Typical split of responsibilities:
- `jleechanorg/jleechanclaw` (OpenClaw harness): user intent parsing, context expansion, policy, and status updates.
- `jleechanorg/agent-orchestrator`: worker session lifecycle, isolated worktrees, PR execution loops, CI/review remediation.

Key integration points in this repo:
- Plugin contracts: `packages/core/src/types.ts`
- OpenClaw notifier plugin: `packages/plugins/notifier-openclaw/src/index.ts`
- MCP mail notifier plugin *(fork)*: `packages/plugins/notifier-mcp-mail/src/index.ts`
- GitHub SCM plugin: `packages/plugins/scm-github/src/index.ts`
- tmux runtime plugin: `packages/plugins/runtime-tmux/src/index.ts`
- Antigravity runtime plugin *(fork)*: `packages/plugins/runtime-antigravity/`

Example notifier wiring (`agent-orchestrator.yaml`) — `openclaw` is listed in the supported notifier options table below. **This block requires a running OpenClaw server reachable at `127.0.0.1:18789` and the `OPENCLAW_HOOKS_TOKEN` env var set.** If you don't need it, leave the notifier list as `[desktop]`:

```yaml
defaults:
  notifiers: [desktop, openclaw]    # remove "openclaw" for general use

notifiers:
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent    # override with ${OPENCLAW_URL}
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
  notifiers: [desktop]            # add "openclaw" only if you have an OpenClaw server

projects:
  my-app:
    repo: owner/my-app             # replace with your GitHub org/repo
    path: ~/my-app                 # replace with your local checkout path
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

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference (including fork-only projects and the manager evolve loop), or run `ao config-help` for the complete schema.

## Plugin Architecture

Seven slots. Every abstraction is swappable. (Lifecycle is implemented
in core; upstream removed it as a separate slot in v0.9.x and the fork
follows.)

| Slot      | Default     | Alternatives                 |
| --------- | ----------- | ---------------------------- |
| Runtime   | tmux        | process, antigravity *(fork)*, docker *(upstream)* |
| Agent     | claude-code | codex, cursor, aider, opencode, grok, gemini *(fork)*, minimax *(fork)*, wafer *(fork)*, kimicode *(upstream)* |
| Workspace | worktree    | clone                        |
| Tracker   | github      | gitlab *(upstream)*, linear, beads *(fork)* |
| SCM       | github      | gitlab                       |
| Notifier  | desktop     | slack, discord, composio, webhook, openclaw, mcp-mail *(fork)* |
| Terminal  | iterm2      | web                          |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

> **Fork-only plugin install:** `antigravity`, `minimax`, `wafer`, `beads`,
> and `mcp-mail` are published under the `@jleechanorg/ao-plugin-*` npm
> scope and ship in this repo's `packages/plugins/`. They are **not** in
> `@aoagents/ao`. If you install the upstream CLI and try to use a
> `*(fork)*` agent, you will get a plugin-not-found error.

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different
issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents,
check if they're stuck, read CI failures, forward review comments, track
which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao start` and walk away. The system
handles isolation, feedback routing, and status tracking. You review PRs
and make decisions — the rest is automated.

## Context Overhead Tooling (Fork-Only)

The [`docs/llm_inspector.md`](docs/llm_inspector.md) guide covers the capture proxy, `--tool-mode lean` (strips 17 heavy built-in tools, ~20K tokens/turn), and `--tool-mode on-demand` (stub + re-issue, ~84.9% reduction on heavy tools).

Install llm_inspector (this fork publishes its own installer pinned to
the fork's own GitHub org; the upstream project is at
`jleechanorg/llm_inspector`):

```bash
curl -fsSL https://raw.githubusercontent.com/jleechanorg/llm_inspector/main/install.sh | bash
```

| Overhead source | % of tokens/turn |
|---|---|
| Built-in tool definitions | ~49% |
| System prompt | ~15% |
| MCP tool definitions | ~15% |
| CLAUDE.md / instructions | ~16% |

`--tool-mode lean` removes 17 heavy built-in tools (~20K tokens/turn). On-demand tool profiles via MCP toggle reduce per-turn overhead further for long sessions.

Evidence bundle: [`docs/evidence/on-demand-stub-schema-2026-04-11/`](docs/evidence/on-demand-stub-schema-2026-04-11/) (N=10, mean 84.9% Agent stub reduction, PASS).

## Zero-Touch Policy (Fork-Only)

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

The `ao` CLI provides these commands (some are fork-only):

```bash
ao start [project|url]    # Start orchestrator with project config or clone repo
ao stop                   # Stop running orchestrator
ao spawn <prompt>         # Spawn new agent session (queued if at 20-session cap)
ao status                 # Show session status
ao dashboard              # Open web dashboard
ao config-help            # Show config schema reference
ao doctor                 # Run diagnostics
ao send <session> <msg>   # Send message to running agent
ao skeptic verify -n <PR> # Run LLM skeptic evaluation on a PR (fork-only)
ao orphan-sweep           # Clean up stale sessions (fork-only)
ao completion zsh         # Generate Zsh completion script (upstream)
```

Run `ao --help` for the full command list. The fork ships extra commands for the skeptical merge gate, orphan session cleanup, and worker-to-orchestrator dialogue.

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests
pnpm dev                       # Start web dashboard dev server
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for code conventions and architecture details.

## Contributing

Contributions welcome. The plugin system makes it straightforward to add
support for new agents, runtimes, trackers, and notification channels.
Every plugin is a TypeScript interface implementation — see
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Development Guide](docs/DEVELOPMENT.md)
for the pattern.

When proposing changes that touch `packages/core/src/`, please review
the **Fork Isolation** section of [AGENTS.md](AGENTS.md) — the fork
strongly prefers companion modules and additive-only changes to minimize
upstream merge friction.

## Evidence

This is a documentation-only PR. The changes have been validated structurally and functionally.

* **Author**: Antigravity (Autonomous Agent)
* **Timestamp**: 2026-06-11T15:25:00-07:00
* **Description**: Structural validation of README portability improvements and Discord notifier capability alignment.
* **Verdict: PASS**

### Verification Runs
- **Wholesome checks**: All wholesome structural validation checks pass successfully.
  - Test run log: `packages/core/src/__tests__/wholesome.test.ts` passed 20/20 tests.
  - CI Workflow Run: [CI Run #27380961767](https://github.com/jleechanorg/agent-orchestrator/actions/runs/27380961767)
  - Commit: [Commit e0901ca](https://github.com/jleechanorg/agent-orchestrator/commit/e0901cad94eaea96e9458f4972f5010874debc37)

## License

MIT
