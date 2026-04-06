# dispatch-task — OpenClaw / gateway → AO worker (orch-nkg)

**Trigger:** OpenClaw embedded agent receives a **coding** task (files, PRs, beads) and must **not** execute inline.

## Protocol

1. **Claim work**: `br update <bd-id> --status in_progress` or `br create "…" --type task --priority …`
2. **Project**: `ao projects list` → use **`agent-orchestrator`** for this repo’s `bd-*` beads unless the task names another project.
3. **Spawn**: `ao spawn <bd-id> -p agent-orchestrator` (add `--runtime antigravity` only if the task requires it).
4. **Send**: write the full task (including resolved slash-command bodies) to a file; `ao send <session> --file <path>` — do **not** use `--no-wait` for the primary handoff.

## Related

- Full routing (Path A `ao spawn` vs Path B gateway HTTP): **`.claude/commands/claw.md`**
- Fork policy: root **`CLAUDE.md`**, **`roadmap/claude-fork-reference.md`**
