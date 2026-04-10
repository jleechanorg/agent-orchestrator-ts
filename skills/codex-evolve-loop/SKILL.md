---
name: codex-evolve-loop
description: Codex-native AO evolve loop. Run a deterministic local observe/measure cycle, then optionally delegate targeted fixes via /claw using the canonical evolve-loop skill.
---

# Codex Evolve Loop

Use this skill when you need a Codex-native version of the `evolve-loop` workflow in this repo.

## Source of truth

- Canonical loop policy: `/Users/jleechan/.claude/skills/evolve-loop/SKILL.md`
- Local deterministic cycle executor: `/Users/jleechan/project_agento/agent-orchestrator/scripts/codex-evolve-cycle.sh`
- Long-running bounded loop: `/Users/jleechan/project_agento/agent-orchestrator/scripts/codex-eloop.sh`

## Workflow

1. Run the local cycle executor first:
   ```bash
   cd /Users/jleechan/project_agento/agent-orchestrator
   REPORT_DIR=/tmp/codex-evolve-cycle-$(date +%Y%m%d-%H%M%S) \
     APPEND_ROADMAP=1 \
     bash ./scripts/codex-evolve-cycle.sh
   ```
2. Read `summary.json`, `summary.md`, and `tmux-panes.txt` from the report dir.
3. Treat the local cycle as the Codex-native equivalent of the `auton`/observe/measure pass.
4. If a friction point is found, apply harness-style root-cause analysis locally before dispatching `/claw`.
5. Only use `/claw` for targeted fix execution after the local cycle has produced concrete findings.

## Notes

- The generic `auton` skill is repo-specific to `jleechanclaw`, so do not force it on `agent-orchestrator`.
- Prefer REST GitHub calls over GraphQL when quota is exhausted.
- If tmux session count is above 20, stabilize and observe; do not increase worker load unless the issue is critical.
