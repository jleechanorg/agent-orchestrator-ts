---
name: agent-orchestrator
description: "Use this skill when working in repositories managed by Agent Orchestrator or when the user asks how to use `ao` properly. Covers the default AO workflow: bootstrap with `ao start`, dispatch work with `ao spawn`, inspect progress with `ao status` or `ao session ls`, steer sessions with `ao send`, and recover or clean up sessions safely."
---

# Agent Orchestrator

Use AO for durable coding work instead of manually creating worktrees or running agent CLIs directly.

## Default workflow

1. Bootstrap the repo or project with `ao start`.
2. Dispatch non-trivial coding work with `ao spawn`.
3. Inspect live state with `ao status` or `ao session ls`.
4. Send follow-up instructions with `ao send`.
5. Recover or clean up sessions with `ao session restore` and `ao session cleanup`.

## Commands to prefer

```bash
# Start AO in the current repo
ao start

# Start AO for another local repo or clone from GitHub
ao start ~/path/to/repo
ao start https://github.com/owner/repo

# Dispatch work
ao spawn "fix the flaky GitHub SCM retry path"
ao spawn -p agent-orchestrator bd-1234
ao spawn --project agent-orchestrator --claim-pr 456

# Inspect and steer work
ao status
ao session ls
ao send <session-id> "Also update the failing test coverage."

# Recovery and cleanup
ao session restore <session-id>
ao session cleanup --dry-run
```

## Working rules

- Prefer `ao spawn` for coding, debugging, CI fixes, review follow-up, and multi-step work.
- Use direct shell commands only for quick diagnostics or when AO itself is unavailable.
- If multiple projects are configured and cwd does not disambiguate, pass `-p, --project`.
- Prefer the existing AO session lifecycle over ad hoc worktrees and hand-run agent CLIs.
- When editing AO config, read `references/config.md`.

## When not to use AO

- Tiny read-only checks: `git status`, `gh pr view`, `rg`, simple file inspection.
- One-off local diagnostics where starting a full worker would be slower than the task.

## Related files

- Config reference: `references/config.md`
- CLI help: `ao --help`, `ao spawn --help`, `ao start --help`
- Repo policies: `AGENTS.md`, `CLAUDE.md`
- **Binary installation norms:** [Binary Installation — Canonical Install Paths](../../AGENTS.md#binary-installation--canonical-install-paths) — `scripts/setup.sh` for repo maintainers, `npm install -g @jleechanorg/ao-cli` for others; `ao doctor` must pass after any install or update
