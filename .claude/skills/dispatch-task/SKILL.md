# dispatch-task — OpenClaw / gateway → AO worker (orch-nkg)

**Trigger:** OpenClaw embedded agent receives a **coding** task (files, PRs, tracker issues) and must **not** execute inline.

## Protocol

1. **Claim work**: `br update <id> --status in_progress` or `br create "…" --type task --priority …` (or your tracker’s equivalent).
2. **Project**: `ao projects list` → pick the project whose **`root`** matches the repo you are working in, or use the **`-p`** implied by your `/claw` prefix map / user override.
3. **Spawn**: `ao spawn <issue-id> -p <project-id>` (add `--runtime antigravity` only if the task requires it).
4. **Send**: write the full task (including resolved slash-command bodies) to a file; `ao send <session> --file <path>` — do **not** use `--no-wait` for the primary handoff.

## Related

- Full routing (Path A `ao spawn` vs Path B gateway HTTP): **`~/.claude/commands/claw.md`** (user-scope canonical)
- Optional fork policy (agent-orchestrator): root **`CLAUDE.md`**, **`roadmap/claude-fork-reference.md`**
