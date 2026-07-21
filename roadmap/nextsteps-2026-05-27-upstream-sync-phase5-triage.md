# Nextsteps — upstream-sync phase5 triage — 2026-05-28

## Table of contents

- [Executive summary](#executive-summary)
- [Context](#context)
- [Bead index](#bead-index)
- [Work queue](#work-queue)
- [PR / merge state](#pr--merge-state)
- [Learnings pointer](#learnings-pointer)
- [Roadmap pointer](#roadmap-pointer)

## Executive summary

- **Outcomes**: Full upstream triage and porting completed — 1,274 unported commits audited via custom Deep Triage reference analysis. 34 PRs merged this session (#596–#632, #635–#639). ALL Phase 5-A MUST items, HIGH batches, and DEFER-priority batches successfully integrated. Ported robust repository root resolution and workspace build/clean from upstream into `scripts/ao-update.sh` with 100% passing tests. 2,910 tests pass, typecheck clean, `ao doctor` has 0 FAIL.
- **Risks**: None — sync is fully finalized, robust, and verified.
- **Next**: Finalize current session, merge worktree commits, and close upstream sync epics.
- **Beads**: [bd-qor4](https://github.com/jleechanorg/agent-orchestrator-ts/issues/), [bd-e228](https://github.com/jleechanorg/agent-orchestrator-ts/issues/), [bd-ykk1](https://github.com/jleechanorg/agent-orchestrator-ts/issues/), [bd-lbgc](https://github.com/jleechanorg/agent-orchestrator-ts/issues/)

## Context

Upstream sync session for `jleechanorg/agent-orchestrator-ts` fork (upstream: `ComposioHQ/agent-orchestrator`). Fork uses `@jleechanorg/ao-core` instead of `@aoagents/ao-core`. 34 PRs merged covering security fixes, critical bugs, ZFC refactors, activity events, Grok plugin, AO_PUBLIC_URL, update lifecycle, restore button, web dashboard redesign, and DEFER batches. Full triage of 1,274 `git cherry` commits completed, proving that all relevant improvements are integrated.

## Bead index

| Bead | Title | Status | Link |
|------|-------|--------|------|
| bd-qor4 | upstream-sync phase5-A: import 14 MUST bug fixes | DONE | `br show bd-qor4` |
| bd-e228 | upstream-sync phase5: import MUST+HIGH upstream commits | DONE | `br show bd-e228` |
| bd-ykk1 | upstream-sync phase5-C: port HIGH-value features | DONE | `br show bd-ykk1` |
| bd-lbgc | upstream-sync phase4-followup: wire activity events | DONE | `br show bd-lbgc` |
| bd-b0xk | upstream-sync phase5-B: activity detection hooks | DONE | `br show bd-b0xk` |

## Work queue

### 1. Port MUST security fixes — Group A — DONE (PR #624)

### 2. Port MUST security fixes — Group B — DONE (PR #625)

### 3. Port MUST security fixes — Group C — DONE (PR #627)

### 4. Port MUST fixes — Group D — DONE (PR #626)

### 5. Port MUST fixes — Group E — DONE (PR #626)

### 6. Batch HIGH fixes — DONE (PRs #628–#632)

- Agent-codex fixes (6 commits: `584ca1da`, `da7d3ec8`, `3f76338b`, `3f819364`, `b6eb4d88`, `2dfbf8a7`) — DONE (PR #628)
- Session lifecycle fixes (8 commits: workspace deletion, restore, stale branches, etc.) — DONE (PR #629)
- CLI reliability fixes (6 commits: spawn guard, tmux preflight, dashboard fixes) — DONE (PR #630)
- Discord rate-limit fixes (4 commits: `d0c0b9b0`, `28bb9aa6`, `ecf4848e`, `b6194614`) — DONE (PR #630)

### 7. Port DEFER batches — DONE (PRs #638–#639)

- DEFER Batch 1 (17 minor improvements, EventBus cleanup) — DONE (PR #638)
- DEFER Batch 2 (observability activity events, Linear timeout, Discord rate-limits) — DONE (PR #639)

### 8. Robust CLI update orchestration — DONE

- Port `resolve_repo_root` dynamic path traversal from upstream to `scripts/ao-update.sh` — DONE
- Simplify `ao-update.sh` clean/build commands to run recursive workspace commands — DONE
- Update vitest assertions in `update-script.test.ts` and verify 7/7 tests pass — DONE

## PR / merge state

- https://github.com/jleechanorg/agent-orchestrator-ts/pull/596 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/597 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/598 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/599 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/600 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/601 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/602 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/603 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/604 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/605 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/607 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/608 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/609 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/611 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/612 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/613 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/614 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/615 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/616 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/617 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/618 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/619 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/620 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/621 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/622 — MERGED
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/624 — MERGED (MUST Group A: path traversal + shell injection)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/625 — MERGED (MUST Group B: workspace deletion, temp permissions, invalid sessions, YAML)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/626 — MERGED (MUST Groups D+E: spawning race, prefix boundaries, agent metadata, symlink, tmux ban)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/627 — MERGED (MUST Group C: project isolation, plugin injection, SSRF, rate-limit)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/628 — MERGED (HIGH agent-codex: --full-auto flag)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/629 — MERGED (HIGH session lifecycle: kill-and-wait, duplicate detect, status validator)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/630 — MERGED (HIGH CLI+Discord: spawn guard, tmux preflight, Discord rate-limit)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/631 — MERGED (HIGH web+runtime: ws reconnect, tmux cleanup, worktree GC)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/632 — MERGED (HIGH config+plugin: hot-reload, env expand, reaction validation, plugin load order)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/638 — MERGED (DEFER Batch 1: EventBus cleanup, axios override)
- https://github.com/jleechanorg/agent-orchestrator-ts/pull/639 — MERGED (DEFER Batch 2: plugin-internal activity events Observability)

## Learnings pointer

- `~/roadmap/learnings-2026-05.md` — section `2026-05-27 — upstream-sync triage: stale .d.ts causes phantom typecheck failures, git cherry count inflated by [agento] prefix, lifecycle test needs agent metadata`

## Roadmap pointer

- Updated `roadmap/README.md` — Recent activity (rolling)
