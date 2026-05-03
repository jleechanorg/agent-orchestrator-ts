---
"@aoagents/ao-plugin-agent-claude-code": patch
---

Fix `toClaudeProjectPath` to fold underscores (and any other non-alphanumeric character) to dashes, matching Claude Code's actual on-disk slug encoding. Previously only `/`, `.`, and `:` were normalized, so AO project data dirs of the form `<sanitized>_<hash>` produced slugs that pointed to non-existent directories — `getSessionInfo` and `getRestoreCommand` could never locate the session JSONL, `claudeSessionUuid` never got persisted, and restoring orchestrator/worker sessions in any multi-project setup failed with a 409 "getRestoreCommand returned null". Fixes #1611.
