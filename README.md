# Agent Orchestrator

Open-source system for orchestrating parallel AI coding agents. Agent-agnostic, runtime-agnostic, tracker-agnostic.

**Core principle: Push, not pull.** Spawn agents, walk away, get notified when your judgment is needed.

## Features

- **8 plugin slots** — Runtime (tmux, docker, k8s), Agent (Claude Code, Codex, Aider), Workspace (worktree, clone), Tracker (GitHub, Linear), SCM (GitHub), Notifier (desktop, Slack), Terminal (iTerm2, web), Lifecycle (core)
- **Agent-agnostic** — Works with Claude Code, Codex, Aider, Goose, or custom agents
- **Runtime-agnostic** — Run in tmux (local), Docker, Kubernetes, SSH, or E2B
- **Tracker-agnostic** — GitHub Issues, Linear, Jira (extensible)
- **Auto-reactions** — CI failures, review comments, merge conflicts → auto-handled
- **Push notifications** — Desktop, Slack, Discord, Webhook, Email
- **Web dashboard** — Real-time session monitoring with SSE
- **TypeScript** — Strict types, ESM modules, Zod validation

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Copy and configure
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
# Edit agent-orchestrator.yaml with your settings (see Configuration section)

# Start the web dashboard
cd packages/web
pnpm dev

# Or use the CLI
pnpm --filter @composio/ao-cli build
./packages/cli/bin/ao.js start
```

## Configuration

Agent Orchestrator reads `agent-orchestrator.yaml` from your working directory.

### Minimal Example

```yaml
# Paths
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees
port: 3000

# Projects
projects:
  my-app:
    repo: org/my-app
    path: ~/my-app
    defaultBranch: main
```

### Using Secrets Securely

**⚠️ NEVER commit real secrets to git!**

Use environment variables for all tokens and API keys:

```yaml
notifiers:
  slack:
    plugin: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}  # Reference env var

projects:
  my-app:
    tracker:
      plugin: linear
      apiKey: ${LINEAR_API_KEY}  # Reference env var
```

Then set in your shell:
```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
export LINEAR_API_KEY="lin_api_..."
export GITHUB_TOKEN="ghp_..."
```

See [SECURITY.md](./SECURITY.md) for best practices.

### Full Example

See [`agent-orchestrator.yaml.example`](./agent-orchestrator.yaml.example) for all options.

## Commands

```bash
# Development
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm dev              # Start web dashboard (dev mode)
pnpm test             # Run tests

# Code quality
pnpm lint             # Check linting
pnpm lint:fix         # Auto-fix linting
pnpm format           # Format with Prettier
pnpm typecheck        # TypeScript type checking

# Package management
pnpm clean            # Clean build artifacts
```

## Architecture

### Plugin Slots

Every abstraction is swappable:

| Slot      | Interface   | Default Plugins |
| --------- | ----------- | --------------- |
| Runtime   | `Runtime`   | tmux, process, docker, kubernetes, ssh, e2b |
| Agent     | `Agent`     | claude-code, codex, aider, goose, opencode |
| Workspace | `Workspace` | worktree, clone |
| Tracker   | `Tracker`   | github, linear |
| SCM       | `SCM`       | github |
| Notifier  | `Notifier`  | desktop, slack, composio, webhook |
| Terminal  | `Terminal`  | iterm2, web |
| Lifecycle | (core)      | — |

All interfaces defined in [`packages/core/src/types.ts`](./packages/core/src/types.ts).

### Directory Structure

```
packages/
  core/          — @composio/ao-core (types, config, services)
  cli/           — @composio/ao-cli (the `ao` command)
  web/           — @composio/ao-web (Next.js dashboard)
  plugins/
    runtime-{tmux,process,docker,kubernetes,ssh,e2b}/
    agent-{claude-code,codex,aider,goose,opencode}/
    workspace-{worktree,clone}/
    tracker-{github,linear}/
    scm-github/
    notifier-{desktop,slack,composio,webhook}/
    terminal-{iterm2,web}/
  integration-tests/
```

## Security

🔒 **This repository uses automated secret scanning** to prevent accidental commits of API keys, tokens, and other secrets.

### For Developers

- **Pre-commit hook** — Scans staged files before every commit
- **CI pipeline** — Scans full git history on every push/PR
- **Gitleaks** — Industry-standard secret detection

Before committing:
```bash
# Scan current files
gitleaks detect --no-git

# Scan staged files (automatic in pre-commit hook)
gitleaks protect --staged
```

### For Users

- **Use environment variables** for all secrets
- **Never hardcode** tokens in config files
- Store `agent-orchestrator.yaml` securely (it's in `.gitignore`)
- Rotate tokens regularly

See [SECURITY.md](./SECURITY.md) for detailed security practices and how to report vulnerabilities.

## Required Secrets

Depending on which features you use, you may need:

| Service | Environment Variable | Where to Get |
|---------|---------------------|--------------|
| GitHub | `GITHUB_TOKEN` | https://github.com/settings/tokens |
| Linear | `LINEAR_API_KEY` | https://linear.app/settings/api |
| Slack | `SLACK_WEBHOOK_URL` | https://api.slack.com/messaging/webhooks |
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `pnpm test`
5. Run linting: `pnpm lint && pnpm typecheck`
6. Commit (pre-commit hook will scan for secrets)
7. Open a pull request

See [CLAUDE.md](./CLAUDE.md) for code conventions and architecture details.

## License

MIT — see [LICENSE](./LICENSE) file.

## Responsible Disclosure

If you discover a security vulnerability, please report it to security@composio.dev. See [SECURITY.md](./SECURITY.md) for details.

## Tech Stack

- **TypeScript** (ESM modules, strict mode)
- **Node 20+**
- **pnpm** workspaces
- **Next.js 15** (App Router) + Tailwind
- **Commander.js** CLI
- **YAML + Zod** config
- **Server-Sent Events** for real-time
- **ESLint + Prettier**
- **vitest** for testing

## Resources

- **Documentation**: See individual package READMEs
- **Core types**: [`packages/core/src/types.ts`](./packages/core/src/types.ts)
- **Example config**: [`agent-orchestrator.yaml.example`](./agent-orchestrator.yaml.example)
- **Security policy**: [SECURITY.md](./SECURITY.md)
- **Code conventions**: [CLAUDE.md](./CLAUDE.md)
