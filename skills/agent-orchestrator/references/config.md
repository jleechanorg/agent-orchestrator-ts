# Agent Orchestrator Config Reference

Use this when editing `agent-orchestrator.yaml`.

## Default structure

```yaml
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]
  modelByCli:
    codex:
      model: gpt-5-codex

projects:
  my-app:
    repo: owner/my-app
    path: ~/code/my-app
    defaultBranch: main
    sessionPrefix: myapp

    agent: codex
    modelByCli:
      codex:
        model: gpt-5-codex

    agentConfig:
      permissions: default
      model: claude-sonnet-4-20250514

    worker:
      agentConfig:
        permissions: auto-edit

    orchestrator:
      agent: claude-code
      agentConfig:
        orchestratorModel: claude-opus-4-1

    reactions:
      ci-failed:
        auto: true
        action: send-to-agent
```

## Model selection

- `defaults.modelByCli.<agent>.model`: global CLI-specific worker default.
- `defaults.modelByCli.<agent>.orchestratorModel`: global CLI-specific orchestrator default.
- `projects.<id>.modelByCli`: per-project override, wins over `defaults.modelByCli`.
- `agentConfig.model`: shared fallback when there is no CLI-specific override.

## Operational reminders

- Use `ao config-help` for the full schema dump.
- Use `ao start` to create a config on first run instead of hand-authoring from scratch.
- Prefer CLI-specific model defaults under `modelByCli` when different agents need different model families.
