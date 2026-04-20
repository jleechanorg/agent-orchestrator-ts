# PR 474 Design Note — Local Main Divergence Preservation

## Status

2026-04-20: implementation PR is https://github.com/jleechanorg/agent-orchestrator/pull/474.

## Goal

Preserve local Agent Orchestrator changes that were found on `main` after integrating upstream work, while keeping the protected `main` branch merge-only through a reviewed PR.

## Tenets

- Do not push local divergence directly to `main`.
- Keep existing AO worker logging and evolve-loop documentation intact.
- Make gate logic fail closed when verdict or shell parsing evidence is ambiguous.
- Keep evidence reproducible through committed tests, CI logs, and terminal media.

## Design

The PR keeps the local divergence as a normal branch and adds focused hardening around the areas that blocked review:

- AO worker JSONL logging records launch, prompt-delivery, and message-send events with structured metadata.
- Message-send telemetry now records success only after the runtime send completes, and records error details when dispatch fails.
- The metadata hook fails closed for chained guarded `gh pr create` / `gh pr merge` commands, including command substitution, subshell/grouping, process substitution, and unsafe `cd` operator forms that can hide the guarded command. Direct guarded commands with single-quoted literal `$()` / backtick text remain allowed.
- The Skeptic Gate workflow only accepts fresh SHA-bound comments that contain the `<!-- skeptic-agent-verdict -->` marker, preventing ordinary PR notes from satisfying the gate.
- The workflow extracts the last anchored verdict token, matching the skeptic reviewer’s fail-closed “last verdict wins” behavior.

## Beads Scope

The `.beads/issues.jsonl` diff is intentional because this PR preserves the local branch state that was found on `main`; it is not runtime logic. The relevant PR-474 follow-up edits are the `bd-o4s` reopen timestamp, the `bd-h26a` duplicate closure relationship, and the surrounding local tracker replay entries that were already part of the divergence being moved behind a reviewed PR.

## Evidence Mapping

- Hook safety: `packages/core/src/__tests__/metadata-updater-hook.test.ts`.
- Skeptic verdict binding: `packages/core/src/__tests__/skeptic-chain-integration.test.ts`.
- Message-send telemetry: `packages/core/src/__tests__/session-manager.test.ts`.
- Workflow syntax: `actionlint .github/workflows/test.yml`.
- Terminal media: `docs/evidence/pr-474/terminal.cast`.
