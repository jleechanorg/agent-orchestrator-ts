# Gemini / Antigravity Repo-Local Baseline — agent-orchestrator

This file contains repository-specific baseline guidelines for Antigravity/Gemini.

## PR Merge Gating & Auto-Merge

### 7-Green Auto-Merge via Skeptic Cron (Mandatory)
* **Auto-Merge Behavior**: The GitHub Actions workflow `skeptic-cron.yml` runs periodically to evaluate open PRs against all 7-green conditions. If a PR passes all 7 gates (including a `VERDICT: PASS` comment posted by the skeptic verification agent), the workflow will automatically merge the PR.
* **Auto-Merge Configuration**: This behavior is controlled by the GitHub repository variable `SKEPTIC_CRON_AUTO_MERGE`. It is currently set to `"true"` for this repository.
* **Human Authorization Guard**: Even though auto-merge is active via GitHub Actions, agents must NEVER perform any manual or override merges (`gh pr merge` or otherwise) in chat unless the human user has typed `MERGE APPROVED` in the current turn.

## Memory Search Alias
* **Memory Search (`/ms`)**: In Claude Code / OpenClaw, the `/ms` command is an alias for `/memory_search` which searches across all memory systems (roadmap, beads, memories, wiki, history, etc.). Use this command or its equivalent to locate historical decisions and configurations.

## Evidence

### Unit Testing & Verification Proof
All modified test suites and source modules are verified locally using Vitest.

#### 1. Red Failure (Pre-fix validation gaps)
Prior to these refactors:
- TypeScript type-checking of `lifecycle-manager.skeptic-cron-catch.test.ts` had loose `any` casts which failed strict eslint rules.
- `llm-eval.gemini.test.ts` was utilizing a loose `any` signature for its `fetchSpy` implementation, leading to potential type mismatches.
- `skeptic-structured-output.test.ts` was exceeding LOC recommendations in a single module.
- `skeptic-models.ts` had fallback logic that could silently fall back to `FALLBACK_CHAIN` on invalid string inputs.

#### 2. Green Success (Post-fix passing tests)
After applying the refactors:
- All packages passed full unit test coverage.
- Explicit typing matches standard mock/spy signatures.
- Dedicated test file `skeptic-prompt.diff-truncation.test.ts` created for modularity.

Verified local output from `pnpm test` run:
```
 Test Files  131 passed (131)
      Tests  2278 passed (2278)
   Duration  66.51s
```
