# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity (rolling)

### 2026-04-06

- **CLAUDE.md + fork reference** — Slim root `CLAUDE.md`, deep reference in [`claude-fork-reference.md`](./claude-fork-reference.md): [PR #383](https://github.com/jleechanorg/agent-orchestrator/pull/383).
- **Docs + defaults** — `tryClaudePrint` flag docs aligned with implementation ([PR #384](https://github.com/jleechanorg/agent-orchestrator/pull/384)); default AO agent set to **cursor** ([PR #385](https://github.com/jleechanorg/agent-orchestrator/pull/385)).
- **Compaction program** — Beads for telemetry + upstream follow-ups merged ([PR #386](https://github.com/jleechanorg/agent-orchestrator/pull/386)); long-form roadmap [`context-compaction-optimization.md`](./context-compaction-optimization.md) + fork cross-link ([PR #387](https://github.com/jleechanorg/agent-orchestrator/pull/387)). **bd-tl9t** (telemetry capture) **closed** — findings live in roadmap + JSONL.
- **CLI** — `ao update` / smoke scripts resolve repo root and use CLI dist ([8682deff](https://github.com/jleechanorg/agent-orchestrator/commit/8682deff)).
- **Branch hygiene** — Stale **`chore/claude-md-fork-reference`** removed after squash merges; active work tracks **`main`**.

### 2026-04-05

- **Skill restoration (bd-pwku)** — Archived loose-md skills restored to **`~/.claude/skills/<name>/SKILL.md`**; repo **`.claude/skills/README.md`** + **`CLAUDE.md`** pointers; duplicate loose files removed. Details: [`skill-restoration.md`](./skill-restoration.md). Pre-change roadmap snapshot: **`~/Downloads/agent-orchestrator-roadmap-*`**.
- **Session registry harness** — New initiative: align `ao session ls` / metadata **`[working]`** with **tmux + JSONL ground truth** so operators are not misled by idle panes. Doc: [`session-registry-harness.md`](./session-registry-harness.md). Bead: **bd-9gvm** (related: **bd-3h9**).
- **Evolve loop & policy** — Landed: healthy-cycle fast path + session budget ([PR #380](https://github.com/jleechanorg/agent-orchestrator/pull/380)); Phase 7 recap + Phase 8 idle auto-cancel ([PR #381](https://github.com/jleechanorg/agent-orchestrator/pull/381)); Zero-Framework Cognition (ZFC) section in CLAUDE.md ([PR #382](https://github.com/jleechanorg/agent-orchestrator/pull/382)).
- **Skeptic** — `claude --print` runs from `/tmp` to avoid project `CLAUDE.md` hooks skewing evaluation (commit `7a9890f9`).

### Older entries

See individual docs below; long-form evolve-loop cycles remain in [`evolve-loop-findings.md`](./evolve-loop-findings.md).

## Documents by theme

| Topic | File |
|--------|------|
| Skill restoration (user scope vs repo) | [skill-restoration.md](./skill-restoration.md) |
| Claude Code context compaction (thresholds, beads bd-cx*) | [context-compaction-optimization.md](./context-compaction-optimization.md) |
| Session / CLI observability harness | [session-registry-harness.md](./session-registry-harness.md) |
| Evolve loop history & metrics | [evolve-loop-findings.md](./evolve-loop-findings.md) |
| Skeptic + AO worker architecture | [skeptic-ao-worker-architecture.md](./skeptic-ao-worker-architecture.md) |
| Harness engineering (Ryan talk) | [harness-engineering-v2.md](./harness-engineering-v2.md) |
| Autonomy / green loop | [autonomy-gaps.md](./autonomy-gaps.md), [green-loop-e2e.md](./green-loop-e2e.md), [7green-enforcement-gaps.md](./7green-enforcement-gaps.md) |
| API / rate limits | [api-rate-limit-mitigation.md](./api-rate-limit-mitigation.md), [gh-api-reduction-validation.md](./gh-api-reduction-validation.md) |
| Next priority batch | [next-priority-fixes.md](./next-priority-fixes.md) |
| Multi-CLI / TDD roadmap | [autonomous-orchestrator-multi-cli-design.md](./autonomous-orchestrator-multi-cli-design.md), [tdd-bead-roadmap-autonomous-orchestrator.md](./tdd-bead-roadmap-autonomous-orchestrator.md) |
| Zero-touch rate | [zero-touch-6green-rate.md](./zero-touch-6green-rate.md) |

## Beads

Canonical issue list: **`.beads/issues.jsonl`**. Use **`br`** to create/update/close issues.
