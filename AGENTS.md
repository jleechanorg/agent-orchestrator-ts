# Agent Orchestrator — Agent & Contributor Guidelines

This file guides AI coding agents (Claude Code, Codex, Cursor, etc.) working on this codebase.

## Development Hierarchy — How to Add Capabilities

Before writing any code, ask: "Can I achieve this without changing core?"

Follow this order strictly:

### 1. Use Config First
Check whether `agent-orchestrator.yaml` already supports what you need:
- `reactions` — add/override event reactions (ci-failed, changes-requested, agent-stuck, etc.)
- `agentRules` — per-project or global instructions injected into agent system prompts
- `notificationRouting` — control which notifiers receive which priority levels
- `defaults` — set default runtime, agent, workspace, notifiers
- `projects[*].agentConfig` — per-project model, permissions, environment

If the config surface can express the behavior, **stop here**. No code needed.

### 2. Make a New Plugin (existing plugin slot)
If config is not enough, implement a plugin using an existing slot:
- `runtime` — how sessions run (tmux, docker, etc.)
- `agent` — how to talk to an AI agent (claude-code, codex, cursor, opencode, etc.)
- `scm` — source control operations (GitHub, GitLab, etc.)
- `tracker` — issue tracking (GitHub Issues, Linear, etc.)
- `notifier` — notifications (Slack, Discord, openclaw, webhook, etc.)
- `workspace` — how worktrees are set up (worktree, docker-volume, etc.)

Use an existing plugin package as a template. Publish as `@composio/ao-plugin-<slot>-<name>`.

### 3. Make a New Plugin Type (new plugin slot)
If none of the existing slots fit, propose and implement a new plugin slot in `plugin-registry.ts`.
This requires a small core change but keeps the business logic in a plugin.

Open an issue (bead) first to discuss the new slot design before implementing.

### 4. Change Core Code (last resort)
Only modify `packages/core/src/` if the capability genuinely cannot be expressed via config or any plugin slot.

Justify in your PR why options 1–3 were insufficient. Core changes need stronger scrutiny than plugin changes.

---

## Repo Structure

```
packages/core/         # Stable infrastructure — minimize changes
packages/plugins/      # Plugin implementations — preferred home for new work
roadmap/               # Design docs and decision records — first-class, commit freely
.beads/issues.jsonl    # Issue tracker — commit when beads are opened or closed
```

`roadmap/` docs are welcomed and tracked. They are the design record for this fork.

---

## Coding Standards

- **TDD**: write failing tests first, then implement. No code without tests.
- **TypeScript strict**: full type coverage, no `any`, no `// @ts-ignore`.
- **No `**kwargs` equivalents**: explicit named parameters only.
- **Files under ~300 LOC**: split when it aids clarity.
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
- **Never push to main directly** — always open a PR.
- **Never use `git add -A`** — stage only files you changed.

## Fork Isolation — Mandatory for All Changes

This is a fork of `ComposioHQ/agent-orchestrator`. Every code change must prioritize isolation from upstream to avoid merge conflicts.

### Before modifying any `packages/core/src/` file:

1. **Check if it exists upstream** — run `git diff upstream/main -- <file>` to see existing fork divergence
2. **If the file has a large diff already** — extract your logic into a new companion module instead of adding more inline changes
3. **If the file is clean (no fork diff)** — strongly prefer creating a new file over modifying the upstream file
4. **Additive-only exceptions** — adding a new union member, interface field, or export line is acceptable if the change is a single line
5. **Extraction refactors welcome** — removing existing fork logic from upstream files into companion modules is encouraged, even though it restructures the file — it reduces the upstream diff surface

### Pattern: Companion Module

Instead of:
```typescript
// lifecycle-manager.ts (upstream file)
// ❌ Adding 50 lines of fork logic inline
async function checkSession(session: Session) {
  // ... upstream code ...
  // Fork: exit proof validation
  await validateAndEmitExitProof(session, newStatus); // 100 lines added here
}
```

Do:
```typescript
// session-exit-proof.ts (new fork file)
// ✅ Fork logic in its own module
export async function validateAndEmitExitProof(...) { ... }

// lifecycle-manager.ts (upstream file)
// Minimal change: just the import and one-line call
import { validateAndEmitExitProof } from "./session-exit-proof.js";
await validateAndEmitExitProof(session, newStatus, deps);
```

### What's already isolated (safe zones)

- `packages/plugins/agent-base/` — new plugin
- `packages/plugins/agent-cursor/` — new plugin
- `packages/plugins/agent-gemini/` — new plugin
- `packages/plugins/poller-github-pr/` — new plugin
- All `packages/core/src/` files that are net new (evidence-bundle, failure-budget, merge-gate, mcp-mail, etc.)

## Testing

```bash
# Run core tests
pnpm --filter @composio/ao-core test

# Run all tests
pnpm test
```

All tests must pass before pushing. CI failures are blockers — fix them, don't skip.

## PR Target — CRITICAL SAFETY RULE

**NEVER open a PR against `ComposioHQ/agent-orchestrator` (upstream) without explicit approval from jleechan.**

Before running `gh pr create`, verify the `--repo` target or the default remote. If it resolves to `ComposioHQ/agent-orchestrator`, stop and ask for approval before proceeding. The correct default target is always `jleechanorg/agent-orchestrator`.

## Bulk PR Merging

When merging multiple PRs, use the `/bulk-merge` workflow (`.claude/commands/bulk-merge.md`):

1. Verify all PRs are green (CI + mergeable + no unresolved comments + CodeRabbit approved)
2. Categorize: LOW (additive only), MEDIUM (modifies existing files), HIGH (core runtime/API changes)
3. Merge order: low-risk smallest-first, then medium, then high
4. Resolve `index.ts` / `.beads/issues.jsonl` conflicts between merges (keep all lines from both sides)
5. Post-merge: `pnpm build && pnpm test && pnpm typecheck`

## PR Checklist

Before opening a PR, verify:
- [ ] PR target is `jleechanorg/agent-orchestrator` (not ComposioHQ upstream)
- [ ] All existing tests pass
- [ ] New behavior has new tests (TDD)
- [ ] Config-first hierarchy followed (AGENTS.md §Development Hierarchy)
- [ ] No secrets or tokens committed
- [ ] Conventional commit messages

