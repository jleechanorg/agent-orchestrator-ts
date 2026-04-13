# On-Demand Tool Profiles via MCP Toggle

**Created**: 2026-04-11  
**Beads**: bd-h5ye (design), bd-rk90 (ao-agent-proxy impl), bd-cx02 (MCP trim)  
**Related**: [context-compaction-optimization.md](context-compaction-optimization.md), [llm-inspector docs](../llm_inspector/docs/claude-code-context-growth-2025.md)

## Problem

Built-in Claude Code tools (Agent, TeamCreate, TaskCreate, etc.) are injected into every API
request regardless of whether they are used. Measured overhead:

| Profile | Tokens/turn (tool defs only) | % of 200K window |
|---------|------------------------------|-----------------|
| Default (all 57 tools) | ~29K tokens | 14.5% |
| Lean (8 tools) | ~6K tokens | 3.0% |
| **Savings** | **~23K tokens/turn** | **11.5%** |

The `Agent` tool alone costs **~4.6K tokens/turn** because it embeds all 33 custom agent
definitions from `~/.claude/agents/` at runtime.

## Key Findings (from binary analysis + live captures)

1. **`--tools` flag** — fixes built-in tool list at session start; cannot change mid-session
2. **MCP tools ARE reactive** — `mcp.tools` lives in zustand store; `toggleMcpServer()` updates
   the live tool list immediately; the conversation loop reads from state each turn
3. **`CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=1`** — moves agent defs to system-reminder (saves ~2.9K
   from tool def) but total bytes stay similar; not a true on-demand solution
4. **`toggleMcpServer` is mid-session capable** — confirmed in binary; calling it via `/mcp`
   UI or reconnectMcpServer hook updates tools available in the NEXT turn

## Architecture: On-Demand Tool Profiles

```text
Session start (lean):
  --tools "Bash,Read,Write,Edit,Glob,Grep"
  MCP: mcp-strict.json (7 core servers, all ENABLED)
  Heavy MCP proxies: DISABLED in settings (ao-agent-proxy, ao-team-proxy)
  Baseline: ~6K tokens built-in tools + ~7K MCP = ~13K overhead/turn

When agent spawning needed:
  User or Claude: /mcp → toggle "ao-agent-proxy" ON
  → ao-agent-proxy connects, adds spawn_agent tool to live session
  → Next turn has spawn_agent without Agent's 4.6K token overhead
  Net: same capability, ~3K tokens cheaper (proxy desc << Agent desc)

When team coordination needed:
  /mcp → toggle "ao-team-proxy" ON
  → Adds create_team, send_message, assign_task tools
```

## MCP Proxy Design

### ao-agent-proxy (replaces `Agent` built-in)

**Tool**: `spawn_agent(task: string, agent_type?: string, worktree?: boolean)`  
**Implementation**: shells out to `ao spawn "<task>"` or `ao spawn --claim-pr N`  
**Description size**: ~500 bytes vs Agent's 18.5KB — **97% smaller**  
**Location**: `~/.config/mcp-daemon/proxies/ao-agent-proxy.js` (or Python)  
**Port**: 8010 (new daemon slot)

```typescript
// Minimal tool definition
{
  name: "spawn_agent",
  description: "Spawn an AO worker to handle a task autonomously.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task description" },
      pr: { type: "number", description: "PR number to claim (optional)" },
      bead: { type: "string", description: "Bead ID to work on (optional)" }
    },
    required: ["task"]
  }
}
```

**Handler**:
```javascript
case "spawn_agent": {
  const { spawnSync } = require("node:child_process");
  const { task, pr, bead } = args;
  const base = ["spawn"];
  const argv = pr != null
    ? [...base, "--claim-pr", String(pr)]
    : bead != null
      ? [...base, "--bead", String(bead)]
      : [...base, String(task)];
  const child = spawnSync("ao", argv, { encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || "ao spawn failed");
  return { content: [{ type: "text", text: child.stdout }] };
}
```

### ao-team-proxy (replaces TeamCreate/SendMessage/TeamDelete)

**Tools**: `create_team(name)`, `send_to_agent(agent, message)`, `list_team()`  
**Implementation**: wraps AO team API or direct tmux send  
**Description size**: ~800 bytes vs TeamCreate's 7.5KB + SendMessage's 2.7KB  
**Port**: 8011

## Tool Profile Tiers

| Profile | `--tools` flag | Enabled MCP proxies | Total overhead |
|---------|----------------|---------------------|----------------|
| **lean** | `Bash,Read,Write,Edit,Glob,Grep` | none | ~6K tokens |
| **standard** | + `WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode` | none | ~9K tokens |
| **standard+agents** | standard | ao-agent-proxy (toggle on) | ~9.5K tokens |
| **full-minus-teams** | + `Agent,Skill,EnterWorktree,ExitWorktree` | none | ~15K tokens |
| **default (current)** | all 57 | all | ~29K tokens |

**Recommendation**: Use `standard` as default. Toggle `ao-agent-proxy` on when needed.
Saves ~20K tokens/turn vs current default.

## Settings Changes

```json
// ~/.claude/settings.json additions
{
  "mcpServers": {
    "ao-agent-proxy": {
      "type": "http",
      "url": "http://127.0.0.1:8010/mcp",
      "disabled": true
    },
    "ao-team-proxy": {
      "type": "http",
      "url": "http://127.0.0.1:8011/mcp",
      "disabled": true
    }
  }
}
```

### Experimental / Unconfirmed

> ⚠️ The following env var is **not confirmed to exist** — the `--tools` flag is
> session-start only. This may need a wrapper alias/function instead. Verify in binary
> before relying on it.

```json
// Experimental — unconfirmed env var. Do not copy into production settings.
{
  "env": {
    "CLAUDE_CODE_DEFAULT_TOOLS": "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode,NotebookEdit"
  }
}
```

## Shell Alias Pattern (confirmed working today)

```bash
# ~/.profile or ~/.bashrc
alias cl='claude --tools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,EnterPlanMode,ExitPlanMode"'
alias cl-full='claude'  # all tools when needed
```

## llm-inspector lean mode (SHIPPED 2026-04-11)

`llm-inspector` now supports `--tool-mode lean` which strips heavy built-ins at the proxy layer:

```bash
# Start proxy in lean mode — strips Agent, Team*, Task*, etc. from every request
llm-inspector start --tool-mode lean

# Or via env var (for workers/scripts)
LLM_INSPECTOR_TOOL_MODE=lean llm-inspector start
```

**What gets stripped**: Agent, TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskGet, TaskList, TaskOutput, TaskStop, SendMessage, CronCreate, CronDelete, CronList, EnterWorktree, ExitWorktree, Skill, RemoteTrigger (~20K tokens saved per turn for lean sessions).

**Kept**: Bash, Read, Write, Edit, MultiEdit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode, NotebookEdit + all MCP tools.

**Note on proxy-rewrite deferral (CORRECTED 2026-04-11)**: lean mode shipped instead of stub-rewrite because the implementation was simpler, not because the approach is fundamentally broken. The original dismissal conflated "strip schema entirely" with "replace with stub schema." Stub schemas solve both blockers:
1. Schema-absence → stubs preserve callability (model sees tool name + description, generates `tool_use`)
2. SSE buffering → one-time buffer on first heavy-tool call; subsequent turns are unmodified

## llm-inspector proxy-rewrite stub-schema mode (✅ DONE — bd-hoyn)

`--tool-mode on-demand` (stub) replaces heavy tool schemas with minimal stubs, buffers SSE on first use, re-issues with real schema.

### How it works

```text
Request (outgoing):
  Agent tool schema: 18.5KB
  → Proxy replaces with stub: ~100 bytes
  → Forward upstream

Response (streaming back):
  Model generates tool_use for Agent (saw stub)
  → Proxy detects tool_use.name === "Agent" in SSE
  → Buffers SSE remainder
  → Re-issues with full Agent schema
  → Returns re-issued response to Claude Code
  → Session now has real schema in context

Subsequent turns: unmodified (real schema in context)
```

### Stub schema example

```typescript
// Full Agent schema: ~18.5KB / ~4.6K tokens
// Stub (Claude Messages API format — input_schema at top level):
{
  name: "Agent",
  description: "Spawn an autonomous sub-agent to handle a task.",
  input_schema: {
    type: "object",
    properties: { task: { type: "string", description: "Task description" } },
    required: ["task"],
  }
}
// ~150 bytes (min property required — empty {} fails Anthropic validation)
```

### Savings model

| Phase | Tool def size | Round-trips |
|-------|--------------|-------------|
| Turn 1 request | ~97% smaller (stubs) | 0 extra |
| Turn 1 response (heavy tool called) | full schema | 1 extra (~200-400ms) |
| Turns 2+ | full schema (cached in context) | 0 extra |

### Tradeoffs vs lean mode

| Mode | Upside | Downside |
|------|--------|----------|
| lean (shipped) | Zero latency penalty ever | Heavy tools unavailable |
| stub (proxy-rewrite) | Heavy tools work after first use | One-time 200-400ms delay on first heavy-tool call |
| neither | Full capability | Full ~29K token overhead |

### Implementation notes (SHIPPED 2026-04-11)

- **Stub format**: `input_schema` at top level (Claude Messages API native format), NOT `custom.input_schema` (OpenAI format). Must include at least one property — empty `{}` fails Anthropic validation.
- **SSE parsing**: scans buffered text for `content_block_start` events with `tool_use` type referencing stubbed tool names
- **Buffering**: ALL SSE chunks buffered from byte 1 (Safeguard 1: prevents duplicate content)
- **Per-request-id isolation**: `Map<requestId, RequestBuffer>` ensures concurrent requests don't interfere
- **Re-issue**: `reIssueWithFullSchema()` replaces stubs with original full schemas and re-issues synchronously
- **Fallback**: if re-issue fails, stubbed response is forwarded as-is with `_on_demand_reissue_failed` marker in capture
- **Lean sessions**: when no tools are stubbed (no heavy tools in request), request passes through unmodified

## Implementation Roadmap

| Phase | Bead | Work | Savings | Status |
|-------|------|------|---------|--------|
| 0 | — | llm-inspector `--tool-mode lean` proxy strip | -20K tokens for lean sessions | ✅ DONE |
| 0b | bd-hoyn | llm-inspector `--tool-mode on-demand` (stub-schema + SSE buffer + re-issue) | -97% upfront tool def, full capability after first use | ✅ DONE |
| 1 | bd-rk90 | Build ao-agent-proxy MCP server (minimal, ~50 LOC) | -3.5K tokens when Agent needed | pending |
| 2 | bd-h5ye | Add to mcp-daemon start script + settings as disabled-by-default | Structural | pending |
| 3 | bd-cx02 | Combine: MCP trim + disable ao-team-proxy + ao-agent-proxy active | -20K tokens/turn total | pending |
| 4 | — | Shell alias `cl` for standard profile; `cl-full` escape hatch | UX | pending |
| 5 | — | Explore `CLAUDE_CODE_DEFAULT_TOOLS` env var (unconfirmed) | May enable persistent lean default | research |

## Open Questions

1. **Does `CLAUDE_CODE_DEFAULT_TOOLS` env var exist?** — not confirmed; only `--tools` CLI flag is confirmed.
2. **Does `/mcp` toggle work in non-interactive (REPL) mode?** — only confirmed for interactive UI.
3. **Can a PostToolUse hook trigger `toggleMcpServer`?** — would enable true auto-enable on demand.
4. **ao-agent-proxy vs thinclaw** — `thinclaw` (port 18790) has `run_shell` + `list_agents` but no `ao spawn` wrapper — ao-agent-proxy still needed.

## Related Docs

- `llm_inspector/docs/claude-code-context-growth-2025.md` — benchmark data
- `roadmap/context-compaction-optimization.md` — compaction fix track
- `~/.claude/mcp-strict.json` — AO worker lean MCP config (7 servers)
