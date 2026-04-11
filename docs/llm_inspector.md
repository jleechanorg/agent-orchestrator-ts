# llm_inspector

Lightweight Node.js capture proxy for analyzing LLM API request payloads. Understand what's eating your context window.

> **Fork integration note:** `llm_inspector/` is a tracked copy of [jleechanorg/llm_inspector](https://github.com/jleechanorg/llm_inspector) (public). It is used by this AO fork to measure and reduce context overhead. Do not edit `llm_inspector/` directly — submit changes upstream at the source repo, then pull updates here.

## Status

| Feature | Status | Savings |
|---------|--------|---------|
| Capture mode (`start`) | ✅ Stable | Visibility |
| `--tool-mode lean` | ✅ Stable | ~20K tokens/turn |
| `--tool-mode on-demand` (stub + re-issue) | ✅ Stable | ~97% upfront on heavy tools |

See full evidence: [`docs/evidence/on-demand-stub-schema-2026-04-11/`](evidence/on-demand-stub-schema-2026-04-11/) (N=10 run, mean 84.9% Agent schema reduction, PASS).

---

## What It Measures

Baseline from a real Claude Code session (`claude --print "What is 2+2?"`, haiku model):

| Component | Bytes | ~Tokens | % |
|-----------|-------|---------|---|
| Built-in tool definitions | 91,932 | ~26,266 | 49% |
| System prompt | 28,113 | ~8,032 | 15% |
| CLAUDE.md stack (3 levels) | 30,010 | ~8,574 | 16% |
| MCP tool definitions | 27,694 | ~7,913 | 15% |
| Skills list | 7,164 | ~2,047 | 4% |
| **Total overhead** | **184,913** | **~52,832** | **100%** |

At ~53K tokens/turn, a 200K context window fills in ~3 turns without compaction.

---

## How It Works

```
Claude Code
    │  ANTHROPIC_BASE_URL=http://localhost:9000
    │  ANTHROPIC_API_KEY=oauth-proxy
    ▼
llm-inspector :9000   ← captures full JSON request payloads to disk
    │  forwards to http://127.0.0.1:8000/claude
    ▼
ccproxy :8000         ← handles OAuth token refresh → Anthropic API
    ▼
Anthropic API
```

`llm-inspector start` starts ccproxy automatically if it isn't already running.

---

## Install

**Requirements:** Node.js 18+, Python 3.9+

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/jleechanorg/llm_inspector/main/install.sh | bash
```

### Manual

```bash
# 1. Install ccproxy-api (Python OAuth proxy)
uv tool install ccproxy-api   # or: pip install ccproxy-api

# 2. Authenticate ccproxy with Claude OAuth
ccproxy auth refresh claude-api

# 3. Install llm-inspector
npm install -g llm-inspector
```

---

## Quick Start

```bash
# Start capture chain (starts ccproxy + capture proxy)
llm-inspector start

# Route Claude Code through it
export ANTHROPIC_BASE_URL=http://localhost:9000
export ANTHROPIC_API_KEY=oauth-proxy

# Make a request
claude --print "What is 2+2?"

# See what was captured
llm-inspector analyze
```

---

## Tool Modes

### `observe` (default)

Captures all requests and responses for analysis. No modifications.

### `lean` (stable)

Strips 17 heavy built-in tool schemas from every request at the proxy layer:

```bash
llm-inspector start --tool-mode lean
# or
LLM_INSPECTOR_TOOL_MODE=lean llm-inspector start
```

**Stripped tools:** Agent, TeamCreate, TeamDelete, TaskCreate, TaskUpdate, TaskGet, TaskList, TaskOutput, TaskStop, SendMessage, CronCreate, CronDelete, CronList, EnterWorktree, ExitWorktree, Skill, RemoteTrigger (~20K tokens/turn savings for lean sessions).

**Kept:** Bash, Read, Write, Edit, MultiEdit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode, NotebookEdit + all MCP tools.

### `on-demand` (stable)

Replaces heavy tool schemas with ~206-byte stubs before forwarding. On first heavy-tool use by the model, re-issues with the real schema. Heavy tools work, but cost is deferred to first use.

```bash
llm-inspector start --tool-mode on-demand
```

**Stub example (Agent tool):**
- Original: 1,368 bytes → Stub: 206 bytes (84.9% reduction)
- Stub format: Claude Messages API `input_schema` at top level (must have at least 1 property)
- Re-issue latency: ~200–400ms on first heavy-tool call

**Evidence:** [`docs/evidence/on-demand-stub-schema-2026-04-11/`](evidence/on-demand-stub-schema-2026-04-11/) — 10-run real integration test, mean 84.9% reduction, PASS.

---

## Commands

| Command | Description |
|---------|-------------|
| `llm-inspector start` | Start capture chain on port 9000 |
| `llm-inspector start --port 9199` | Custom port |
| `llm-inspector start --upstream <url>` | Forward directly to a URL (skip ccproxy) |
| `llm-inspector start --foreground` | Run in foreground (no daemon) |
| `llm-inspector start --tool-mode lean\|on-demand` | Set tool mode |
| `llm-inspector stop` | Stop capture proxy |
| `llm-inspector status` | Check if running, show capture count |
| `llm-inspector analyze` | Show token breakdown for all captures |
| `llm-inspector analyze --last 5` | Analyze last 5 captures |
| `llm-inspector analyze --sort tokens` | Sort by estimated token count |
| `llm-inspector analyze --json` | Output as JSON |
| `llm-inspector clean` | Remove all captured request files |

---

## ccproxy Setup

ccproxy handles OAuth with the Anthropic API. After installing:

```bash
# Authenticate (opens browser for OAuth flow)
ccproxy auth login

# Or refresh an existing token
ccproxy auth refresh claude-api
```

Config lives at `~/.ccproxy/config.yaml`. The default model entry should have `api_key: claude-api` to use OAuth.

---

## Upstream

**Source:** [github.com/jleechanorg/llm_inspector](https://github.com/jleechanorg/llm_inspector) (public)  
**Evidence bundle:** [llm_inspector/docs/evidence/](llm_inspector/docs/evidence/) in the source repo  
**Design doc:** [`roadmap/on-demand-tool-profiles.md`](roadmap/on-demand-tool-profiles.md)

Changes to `llm_inspector/` in this fork should be submitted as PRs to the source repo first.
