# Slash Command Web Discovery for Non-Claude Agents

**Date:** 2026-03-30
**Issue:** orch-o25

## 1. Problem Statement

### Current State
The `/claw` command handles slash command translation for AO workers (in `~/.openclaw/.claude/commands/claw.md` when present). When dispatching a task that includes a slash command (e.g. `/er`, `/fixpr`), `/claw` optionally resolves the command definition from local files (`.claude/commands/$CMD.md` or `.claude/skills/$CMD/SKILL.md`) and inlines it into the task before dispatching to any agent (Claude Code, Codex, Cursor, MiniMax).

### Gap
Non-Claude agents (primarily **Codex**, OpenAI's CLI) cannot natively understand Claude slash commands like `/er`, `/fixpr`, `/simplify`, etc. The current `/claw` system only resolves from **pre-committed local files**. If a slash command exists in the Claude commands spec but hasn't been committed locally, Codex workers cannot discover or use it.

**Primary target:** Codex — does NOT natively support Claude slash commands.

**Agents that may work natively (verify before adding discovery rules):**
- **MiniMax** — uses Claude internally, may understand slash commands natively
- **Cursor CLI** — has its own slash command system, may be compatible

### Goal
Codex agents can dynamically fetch slash command specs via web search and translate them into executable instructions — without requiring pre-committed local files.

---

## 2. Architecture Options

### Option A — Inline web search in `/claw` dispatch
When a slash command is not found in local files, `/claw` does a web search before dispatching.

**Pros:**
- Centralized in one place — all agents benefit
- Consistent discovery logic

**Cons:**
- Adds latency to every dispatch cycle
- Requires internet access at dispatch time
- Changes the core `/claw` dispatch path — higher risk

### Option B — Agent-side discovery rule in `defaults.agentRules`
Each non-Claude agent inherits a standing instruction to search the web for unknown slash commands.

**Pros:**
- No change to `/claw` dispatch logic
- Agents are self-sufficient — they can discover without `/claw` involvement
- Easy to scope: only Codex gets the rule, not MiniMax/Cursor
- Fail-safe: if the rule is wrong, only Codex is affected

**Cons:**
- Scattered across agent configs (but `defaults.agentRules` is centralized)
- No centralized control over which commands are "supported"

### Option C — Hybrid: centralized registry + agent fallback
`/claw` attempts a centralized slash command registry lookup first; if miss, falls back to agent-side web search.

**Pros:** Best of both worlds
**Cons:** More complex — overkill for the current scope

### Recommended: Option B

The rule goes in `defaults.agentRules` in `agent-orchestrator.yaml`, scoped to agents that do **not** natively support slash commands.

---

## 3. Proposed Implementation

### Slash Command Discovery Rule (for Codex and similar non-Claude agents)

Add to `defaults.agentRules` in `~/.openclaw/agent-orchestrator.yaml`:

```text
**SLASH COMMAND DISCOVERY (for agents that do NOT natively support Claude slash commands):**
If your agent runtime does NOT natively support slash commands (unlike Claude Code, MiniMax, or Cursor CLI),
and you encounter a slash command (e.g. /er, /fixpr, /simplify, /evidence-review) that you cannot resolve:
1. Do a web search for "site:claude.com <command-name> slash command" or "claude code slash command reference"
2. Read the official documentation to understand the command's intent, arguments, and behavior
3. Translate the command into your runtime's equivalent — do NOT ask the user how to translate it
4. Execute the translated command autonomously — use read-only/reversible operations unless explicitly directed
5. If no equivalent exists in your runtime, report what you found and what you would do
```

**Native slash command detection:**
- **Claude Code** — has built-in slash commands, no discovery needed
- **MiniMax** — uses Claude API internally, likely supports slash commands natively
- **Cursor Agent CLI** — has its own slash system, verify before adding this rule
- **Codex (OpenAI CLI)** — does NOT natively support Claude slash commands, needs this rule

### What's NOT changing
- `/claw` command dispatch logic — unchanged
- Claude Code agents — unaffected, use built-in slash commands
- MiniMax/Cursor — only add discovery rule if native support is verified to be absent

---

## 4. TDD Plan

### Phase 1: Write the test first (RED)
- [ ] **Test 1 — Slash command lookup via web search:** Create a temporary directory with NO `.claude/commands` or `.claude/skills` files. Invoke the agent with a task containing `/er fix-something`. Verify the agent performs a web search (check for `curl` or `wget` or `gh api` evidence in session logs).
- [ ] **Test 2 — Successful translation:** After web search, the agent produces a coherent translated instruction based on what it found online.
- [ ] **Test 3 — No regression for Claude Code agents:** Claude Code agents (which have built-in `/er`) continue to work without doing unnecessary web searches.
- [ ] **Test 4 — Error handling:** If web search returns no results, agent reports gracefully (not a silent failure).
- [ ] **Test 5 — agent-orchestrator.yaml is valid YAML:** `python3 -c "import yaml; yaml.safe_load(open('~/.openclaw/agent-orchestrator.yaml'))"` passes with no errors.

### Phase 2: Implement to make tests pass (GREEN)
- [ ] Add SLASH COMMAND DISCOVERY rule to `defaults.agentRules` in `agent-orchestrator.yaml`
- [ ] Verify all Phase 1 tests pass

### Phase 3: Refactor and expand (REFACTOR)
- [ ] Test with actual Codex agent if available
- [ ] Verify MiniMax and Cursor CLI handle slash commands natively (no discovery rule needed)
- [ ] Ensure existing Claude Code agents are not affected (no regression)

---

## 5. Exit Criteria

1. `docs/design/slash-command-discovery.md` exists and covers all 4 sections
2. `agent-orchestrator.yaml` has the new SLASH COMMAND DISCOVERY section in `defaults.agentRules`
3. All 5 local tests (Test 1–5) have been run with recorded proof
4. Branch `feat/orch-o25` pushed to origin with PR open
5. CI checks pass on the PR
6. CR review posted and approved
7. PR is merged to main

---

## 6. What changes and where

| File | Change |
|------|--------|
| `docs/design/slash-command-discovery.md` | New design doc (this file) |
| `~/.openclaw/agent-orchestrator.yaml` | Add SLASH COMMAND DISCOVERY section to `defaults.agentRules` |

> **Note:** `~/.openclaw/agent-orchestrator.yaml` is the user's local AO config (not committed to the repo). The config already has `defaults.agentRules` field — the rule was added there. `agent-orchestrator.yaml.example` in the repo shows the schema; the actual config lives in `~/.openclaw/`.