# Packages code audit — 2026-03-30

Static review of `packages/` in `jleechanorg/agent-orchestrator` for cleanup opportunities, plugin-boundary fit, and Composio/upstream collision risk. No runtime profiling; findings are from repository search and targeted file reads.

**Scope:** `packages/ao`, `packages/cli`, `packages/core`, `packages/integration-tests`, `packages/mobile`, `packages/plugins`, `packages/web`.

**Method:** ripgrep for `composio`, `@composio`, monkey-patching patterns, parallel plugin registration paths; line counts for high-churn core files; manual read of `plugin-registry.ts`, `notifier-composio`, `tracker-linear` Composio transports, CLI agent resolution.

---

## Findings (sorted by severity, then category)

| # | File | Lines (approx.) | Category | Severity | Explanation |
|---|------|-----------------|----------|----------|-------------|
| 1 | `packages/plugins/notifier-composio/src/index.ts` | 44–78 | (b) plugin-candidate / API consistency | **HIGH** | Uses dynamic `import("composio-core")` and duck-typed `Composio` construction. `packages/plugins/tracker-linear/src/index.ts` (126–200) uses `@composio/core` with typed optional peer + `composio-core.d.ts`. Two different package names and loading strategies for the same vendor increase breakage risk and confuse operators (`pnpm add composio-core` vs `@composio/core`). **Recommendation:** align both plugins on one supported SDK surface (prefer `@composio/core` if that is the current official package) and share a tiny internal adapter module if needed. |
| 2 | `packages/cli/src/lib/plugins.ts` | 9–15 | (a) cleanup | **HIGH** | `agentPlugins` registers `claude-code`, `codex`, `cursor`, `aider`, `opencode` but **not** `gemini`, even though `plugin-registry.ts` lists `agent` / `gemini` and `packages/cli/package.json` depends on `@jleechanorg/ao-plugin-agent-gemini`. `getAgent` / `getAgentByName` will throw `Unknown agent plugin: gemini` for CLI paths that use this module (e.g. `send`, `status`), while full session spawn via `createPluginRegistry().loadBuiltins()` can still load Gemini. **Recommendation:** add `gemini` to `agentPlugins` (and tests) or route all CLI agent resolution through the registry to avoid drift. |
| 3 | `packages/cli/src/lib/detect-agent.ts` | 16–22 | (a) cleanup | **HIGH** | `AGENT_PLUGINS` omits `gemini` for runtime detection — same parity gap as #2. Auto-detect and `getAgent*` disagree with built-ins. **Recommendation:** include `@jleechanorg/ao-plugin-agent-gemini` in the detection list. |
| 4 | `packages/core/src/lifecycle-manager.ts` | entire file (~2764 LOC) | (a) cleanup | **HIGH** | File far exceeds the repo’s own “~300 LOC / split for clarity” guideline and is called out in `CLAUDE.md` as a high-conflict upstream merge surface. Much fork logic is already extracted (`session-exit-proof.ts`, `review-backlog.ts`, etc.); remaining opportunities: further extraction of reaction execution branches and SCM-heavy helpers into companions. **Recommendation:** continue companion-module extractions with minimal behavioral change. |
| 5 | `packages/core/src/types.ts` | entire file (~1796 LOC) | (a) cleanup | **MEDIUM** | Central type + config-related types in one file complicate reviews and upstream diff noise. **Recommendation:** split by domain (e.g. session vs SCM vs reactions) behind re-export barrels if/when touched for other reasons. |
| 6 | `packages/core/src/config.ts` | entire file (~633 LOC) | (a) cleanup | **MEDIUM** | Large Zod schema file; same merge-risk class as `types.ts`. Prefer additive field modules when expanding. |
| 7 | `packages/cli/src/lib/plugins.ts` | 17–19, 47–55 | (a) cleanup | **MEDIUM** | Parallel plugin wiring: only `scm-github` is hardcoded while `plugin-registry` loads `scm-gitlab` and others. Projects using GitLab SCM may work in lifecycle paths but fail if CLI helpers call `getSCM` without extending this map. **Recommendation:** align with registry or generate this map from a single source of truth. |
| 8 | `packages/cli/src/commands/skeptic.ts` + `packages/cli/src/commands/skeptic/modelRunner.ts` | e.g. modelRunner 17–26, skeptic CLI `--model` | (a) cleanup | **MEDIUM** | CLI advertises `--model` including `gemini` (`skeptic.ts`), but `runSkepticEvaluation` throws for `gemini` (`modelRunner.ts`). User-facing inconsistency. **Recommendation:** remove `gemini` from CLI help until supported, or implement Gemini via `llm-eval.ts` and one supported path. |
| 9 | `packages/web/server/__tests__/server-compatibility.test.ts` | 28–30, 59–61 | (a) cleanup | **MEDIUM** | Test titles say “does not import loadConfig from **@jleechanorg/ao-core**” but assertions regex-match **`@composio/ao-core`**. The assertion correctly guards against the legacy upstream package string; the **title is misleading**. **Recommendation:** rename `it(...)` strings to mention `@composio/ao-core` (or assert both forbidden import forms explicitly). |
| 10 | `packages/plugins/*/package.json` (many) | `repository.url` / `homepage` | (c) composio-collision (metadata) | **MEDIUM** | Numerous plugin `package.json` files still list `https://github.com/ComposioHQ/agent-orchestrator` while the fork publishes `@jleechanorg/*`. Not runtime collision, but causes incorrect issue links and confuses upstream vs fork ownership. **Example:** `packages/plugins/workspace-worktree/package.json` ~19–25. **Contrast:** `packages/plugins/prose-polish/package.json` correctly points at `jleechanorg`. **Recommendation:** batch-update repository/homepage/bugs URLs to `jleechanorg/agent-orchestrator` for fork packages. |
| 11 | `packages/mobile/app.json` | 18–19, 33 | (c) composio-collision (branding) | **MEDIUM** | iOS `bundleIdentifier` and Android `package` use `com.composio.*` while the app is named “Agent Orchestrator” under the fork. This may be intentional legacy from the upstream fork; if the fork ships independently, these identifiers collide with Composio namespace expectations. **Recommendation:** confirm policy; consider `org.jleechanorg.ao` (or similar) for store builds if legally/product-appropriate. |
| 12 | `packages/plugins/notifier-composio/src/index.ts` | 134–149 (`_clientOverride`) | (a) cleanup | **LOW** | Test-only escape hatch on public config shape. Acceptable for integration tests but leaks into type surface. **Recommendation:** document as internal, or narrow typing to test builds only. |
| 13 | `packages/core/vitest.config.ts` | 13–23 | (c) composio-collision | **LOW** | Aliases `@jleechanorg/ao-core` to source — intentional fork isolation for tests, not upstream breakage. No change required; listed for completeness. |
| 14 | `packages/integration-tests/src/notifier-composio.integration.test.ts` | full file | (c) composio-collision | **LOW** | Tests the fork’s `notifier-composio` plugin; no monkey-patching of Composio internals observed. Uses `_clientOverride` at the boundary — good practice. |
| 15 | `packages/integration-tests/src/tracker-linear.integration.test.ts` | header comments, Composio path | (b) plugin-candidate | **LOW** | Correctly exercises optional Composio transport via env; belongs next to tracker plugin (already the case). No core leakage found. |
| 16 | `packages/ao/bin/ao.js` + `packages/ao/package.json` | — | (a) cleanup | **LOW** | Thin CLI shim package; no Composio-specific logic. Healthy. |
| 17 | `packages/plugins/prose-polish` | manifest slot `runtime` | (b) plugin-candidate | **LOW** | Niche “prose polish” behavior lives in a **runtime** plugin — appropriate plugin slot usage; not a candidate to move *into* core. |
| 18 | `packages/plugins/runtime-tmux/src/agent-liveness.ts` | 5, 21 (comments) | (c) composio-collision | **LOW** | Explicitly documents fork-only / not upstreamed — aligns with isolation policy. |

---

## What was *not* found

- **No** widespread `prototype` / `__proto__` monkey-patching in `packages/` (only unrelated `dispatch`/`patch` wording in tests).
- **No** direct imports of `@composio/ao-core` in application code under `packages/` (web tests actively forbid the old import string).
- **Core LLM evaluation** for skeptic flows routes through `packages/cli/src/lib/llm-eval.ts` and `modelRunner.ts` (good alignment with `CLAUDE.md`).

---

## Suggested follow-up work (outside this document)

1. Single Composio SDK strategy across `notifier-composio` and `tracker-linear`.
2. Unify CLI agent/SCM shortcut maps with `BUILTIN_PLUGINS` or delete shortcuts in favor of registry-only resolution.
3. Gemini parity in `plugins.ts` + `detect-agent.ts`.
4. Metadata sweep: plugin `package.json` repository URLs → fork.
5. Optional: mobile bundle IDs / Android package rename policy decision.

---

## References

- Fork isolation policy: `CLAUDE.md`, `AGENTS.md` (companion modules, minimize `lifecycle-manager.ts` / `types.ts` churn).
- Built-in plugin list: `packages/core/src/plugin-registry.ts` lines 26–62.
