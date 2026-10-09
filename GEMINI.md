# Gemini / Antigravity Repo-Local Baseline — agent-orchestrator

This file contains repository-specific baseline guidelines for Antigravity/Gemini.

## PR Merge Gating & Auto-Merge

### 6-Green (Mandatory) — Skeptic Cron auto-merge retired (PR #773)
* **No more automated Skeptic Cron auto-merge in this repo.** `skeptic-cron.yml` (and `skeptic-gate.yml`, and `test.yml`'s Skeptic trigger job) were deleted in PR #773 — this repo's own Skeptic PR-gating/auto-merge automation is retired. Do not reference `SKEPTIC_CRON_AUTO_MERGE` or expect a `VERDICT: PASS` comment to trigger a merge; that mechanism no longer runs here.
* **Current gating**: PRs must pass the 6-green Green Gate check (CI green, mergeable, CodeRabbit APPROVED, Bugbot clean, inline threads resolved, evidence when required) — see `CLAUDE.md`'s "6-Green (summary)" section for the authoritative definition.
* **Human Authorization Guard (unchanged)**: Agents must NEVER perform any manual or override merges (`gh pr merge` or otherwise) in chat unless the human user has typed `MERGE APPROVED` in the current turn — this rule holds regardless of gate automation.

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

#### 3. Red→Green TDD Proofs (CodeRabbit addressal)
- **Skeptic prompt file path identification**:
  - [TDD Red failure log (skeptic-prompt.diff-truncation.test.ts)](https://gist.github.com/jleechan-af/8f451bf2aca9b198d14ac06f2b3dad0a): Verifies getChangedFiles failed by duplicating old paths for renamed files.
  - [TDD Green success log (skeptic-prompt.diff-truncation.test.ts)](https://gist.github.com/jleechan-af/af0b4d75b9d40f70c62f76dc24bae733): Demonstrates correct file path parsing with renames and deletions after the fix.
- **SCM GitHub PR comment author normalization**:
  - [TDD Red failure log (scm-github index.test.ts)](https://gist.github.com/jleechan-af/ec14dc325de15f0049b868c788376355): Shows that listPRComments fails on null user input and triggers `/skeptic` erroneously.
  - [TDD Green success log (scm-github index.test.ts)](https://gist.github.com/jleechan-af/56edbb0a82392c4b1a8c03538bf87b65): Shows normalized user object `{ login: "", type: null }` preventing false skeptic triggers on comments with null users.

