# Antigravity Orchestrator — Implementation Roadmap

**Epic:** `bd-5kp` — runtime-antigravity: Antigravity IDE as AO worker via Peekaboo
**Design doc:** `docs/design/antigravity-orchestrator.md`
**Branch:** `feat/runtime-antigravity`
**Worktree:** `~/project_agento/worktree_antigravity_orch`

---

## Goal

Use the Antigravity IDE (Google's AI-first VS Code) as an AO worker runtime. Each spawned "session" is an Antigravity conversation running Gemini autonomously — exploiting Google's quota instead of Anthropic/Codex. AO handles worktrees, PR polling, Slack notifications, lifecycle.

---

## Implementation order

### Phase 1 — Shell executor (foundation)
**Bead:** `bd-5kp.2`
**Worktree for coding:** `worktree_antig_scripts`

```
scripts/antigravity/
  start.sh      — open workspace, start conversation, paste prompt, send
  status.sh     — check if conversation is running (progress_activity) or idle
  kill.sh       — navigate to conversation, cancel
  send.sh       — paste follow-up message to open conversation
  lib.sh        — shared: get MANAGER_ID, find workspace element, error handling
```

Reference: `~/.claude/skills/antigravity-computer-use/SKILL.md`

---

### Phase 2 — Plugin skeleton
**Bead:** `bd-5kp.1`
**Worktree for coding:** `worktree_antig_plugin`

```
packages/plugins/runtime-antigravity/
  package.json
  src/
    index.ts        — export AntigravityRuntime class
    runtime.ts      — implements Runtime interface (spawn, status, kill, send)
    queue.ts        — serial async executor (p-queue, concurrency: 1)
    executor.ts     — calls scripts/antigravity/*.sh, captures output
    types.ts        — AntigravitySession, AntigravityConfig
```

Mirror structure from `packages/plugins/runtime-tmux/`.
Runtime interface: `packages/core/src/session-manager.ts`

---

### Phase 3 — Poller
**Bead:** `bd-5kp.6`
**Worktree for coding:** `worktree_antig_scripts` (extend Phase 1)

- `status.sh` returns JSON: `{ "state": "running"|"idle"|"unknown", "conversation": "<title>" }`
- Runtime polls every 15s, emits `session:idle` event when spinner gone
- Integrates with existing `poller-github-pr` for PR-based completion signal
- On completion: fires AO notifier chain (Slack DM by default)

---

### Phase 4 — Claude Code CLI fallback
**Bead:** `bd-5kp.3`
**Worktree for coding:** `worktree_antig_plugin` (extend Phase 2)

- `executor.ts` catches shell failures (exit code ≠ 0, element-not-found in output)
- Falls back to: `claude --dangerously-skip-permissions` with skill context
- Fallback is logged, reported in session metadata
- Other CLIs (codex, gemini) extensible via config

---

### Phase 5 — MCP server tools
**Bead:** `bd-5kp.4`
**Worktree for coding:** `worktree_antig_mcp`

New MCP tools exposed:
| Tool | Args | Description |
|------|------|-------------|
| `antigravity_spawn` | `task, repo, model?, mode?` | Start new conversation in new worktree |
| `antigravity_status` | — | List all active/idle conversations |
| `antigravity_kill` | `session_id` | Cancel running conversation |
| `antigravity_send` | `session_id, message` | Send follow-up to conversation |
| `antigravity_workspaces` | — | List all Antigravity windows/workspaces |

---

### Phase 6 — Config + multi-repo
**Bead:** `bd-5kp.5`
**File:** `agent-orchestrator.yaml`

```yaml
projects:
  ao:
    runtime: antigravity
    path: ~/project_agento/agent-orchestrator
    worktreeDir: ~/.worktrees/antigravity/ao

  jleechanclaw:
    runtime: antigravity
    path: ~/.openclaw
    worktreeDir: ~/.worktrees/antigravity/jlc

  worldarchitect:
    runtime: antigravity
    path: ~/projects/worldarchitect.ai
    worktreeDir: ~/.worktrees/antigravity/wa
```

---

### Phase 7 — Entry points
**Bead:** `bd-5kp.7`

- **CLI:** `ao spawn --runtime antigravity --repo ao "write design for X"`
- **Slack:** parse `antigravity: <task> in repo: <name>` in #ai-general or DM
- **MCP:** `antigravity_spawn(...)` directly from Claude sessions

---

## Parallel coding strategy

Use Antigravity itself to code this up. Each phase gets its own worktree + conversation:

```
Worktree                        Bead       Task
worktree_antig_scripts          bd-5kp.2   shell executor scripts
worktree_antig_plugin           bd-5kp.1   TypeScript plugin skeleton
worktree_antig_mcp              bd-5kp.4   MCP server tools
worktree_antig_config           bd-5kp.5   agent-orchestrator.yaml
```

Start all 4 convos serially (~12s Peekaboo), run in parallel on Gemini quota.
Merge order: scripts → plugin → poller → fallback → MCP → config → entry points.

---

## Key references

| Resource | Path |
|----------|------|
| Antigravity skill | `~/.claude/skills/antigravity-computer-use/SKILL.md` |
| Runtime interface | `packages/core/src/session-manager.ts` |
| Existing runtime example | `packages/plugins/runtime-tmux/` |
| Design doc | `docs/design/antigravity-orchestrator.md` |
| Epic bead | `bd-5kp` (run `br show bd-5kp`) |
