# Agent Gemini Plugin — Design Reference

Design reference for `@composio/ao-plugin-agent-gemini` — integrates Gemini CLI into the AO plugin system as a first-class agent backend.

**Tags:** `process: gemini` · `session path: ~/.gemini/tmp/<sha256>/chats/` · `runtime: tmux` · `permission flag: --yolo`

---

## Purpose

Wraps the `gemini` CLI so AO can spawn, supervise, resume, and introspect Gemini CLI sessions the same way it manages Claude Code and Codex sessions. No AO core changes required — the plugin implements the standard `Agent` interface from `@composio/ao-core`.

---

## Relationship to agent-claude-code

The implementation is structurally identical to `agent-claude-code` (~87% shared code). The two differ in agent-specific constants and one behavioral difference in permission flags:

| Aspect | Gemini | Claude Code |
|--------|--------|-------------|
| Process name | `gemini` | `claude` |
| Session directory | `~/.gemini/tmp/<sha256(workspacePath)>/chats/` | `~/.claude/projects/<encoded-path>/` |
| Permission flag | `--yolo` | `--dangerously-skip-permissions` |
| System prompt flag | Not supported | `--append-system-prompt` |

> A shared `agent-jsonl-utils` extraction is tracked as a follow-up.

---

## Launch

| Flag | Description |
|------|-------------|
| `gemini` | Base command |
| `-r / --resume <sessionId>` | Resume existing session |
| `--yolo` | Auto-approval / permissionless mode |
| `--model <name>` | Optional model override |

**Delivery:** Prompt delivered post-launch via `sendMessage()`. System prompts also delivered post-launch (no CLI flag support).

---

## Session Tracking

- **Location:** Native JSON files in `~/.gemini/tmp/<sha256(workspacePath)>/chats/`
- **Selection:** Latest file selected by `mtime`
- **File format:** Top-level JSON object `{ sessionId, messages: [{ type, content, id, timestamp }, ...] }`
- **Path encoding:** `toGeminiProjectPath()` SHA-256 hashes the workspace path (unlike Claude Code's path-mangling)

---

## Activity Detection

| State | Trigger |
|-------|---------|
| Active | Last message type is `"user"` or `"info"` |
| Ready | Last message type is `"gemini"` (agent completed its turn) |
| Idle | Any state older than the ready threshold (default 5 min) |
| Blocked | Last message type is `"error"` |

Reads the last entry in the `messages` array of the native JSON session file.
**Process check:** Via `ps` across all tmux pane TTYs.

---

## Agent Interface Implementation

Implements the full `Agent` interface:

- `getLaunchCommand(config)` — builds the `gemini` CLI string
- `getEnvironment(config)` — injects `AO_SESSION_ID` and metadata env vars
- `isProcessRunning(handle)` — checks tmux pane TTYs via `ps` for `gemini`
- `getActivityState(handle)` — native JSON message-type classification (user/gemini/error/info)
- `getSessionInfo(session)` — extracts summary, cost, and session UUID from JSON session file
- `getWorkspaceHooks()` — installs metadata-updater hook

---

## Plugin Registration

Registered as a built-in plugin in the AO plugin loader:

```javascript
// packages/plugins/dist/index.js
import geminiPlugin from "@composio/ao-plugin-agent-gemini";

export const builtinPlugins = [
  claudeCodePlugin,
  codexPlugin,
  geminiPlugin,   // ← added
  ...
];
```

Consumers can also override it per-project via `ao.config.json` `agentPlugin` key.

---

## Key Differences from Claude Code

### Permission Flag

Gemini uses `--yolo` for auto-approval; both `permissionless` and `auto-edit` modes map to this flag.

### No System Prompt Flag

Gemini CLI has no `--append-system-prompt` equivalent. System context and prompts are both delivered post-launch via `sendMessage()`.

### Cost Estimation

Falls back to Gemini 2.0 Flash pricing ($0.10/M input, $0.40/M output) when no direct `costUSD` field is present in the JSONL.

---

## Constraints & Known Gaps

### One-shot vs Interactive

`gemini -p` (headless) exits after one response. Interactive mode (`gemini` alone, prompt delivered via stdin) is required for multi-turn AO sessions.

### Cost Estimation Accuracy

Gemini Flash pricing is used as a rough baseline. Multi-modal inputs and premium models will be mis-estimated until Gemini CLI exposes per-call cost in JSONL.

### Code Duplication

~700 lines shared verbatim with `agent-claude-code`. Tracked for extraction to a shared utility module.

---

## Testing

| Test File | Coverage |
|-----------|----------|
| `src/index.test.ts` | Manifest, launch command, process detection, session parsing |
| `src/__tests__/activity-detection.test.ts` | Native JSON message-type activity states with real temp directories |

All tests use real filesystem operations — no filesystem mocks.

---

## Future Work

1. **Update cost estimation** when Gemini CLI exposes per-call token pricing in session files
2. **Investigate `--append-system-prompt` equivalent** when Gemini CLI adds system prompt support
3. **Make pricing configurable per-project** so operators running non-Flash models get accurate estimates

---

## See Also

- [agent-claude-code plugin](../agent-claude-code-plugin.md) — Reference implementation this plugin parallels
- [AO Plugin System Architecture](../../architecture/plugin-system.md) — Plugin interface specifications
