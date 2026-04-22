# Nextsteps — Non-Conflicting Code Restructure — 2026-04-22

## Table of contents

- [Executive summary](#executive-summary)
- [Context](#context)
- [Bead index](#bead-index)
- [Work queue](#work-queue)
- [PR / merge state](#pr--merge-state)
- [Learnings pointer](#learnings-pointer)
- [Roadmap pointer](#roadmap-pointer)

## Executive summary

- **Outcome**: Zero upstream commits merge cleanly — structural divergence too deep for cherry-pick. But the fork has non-conflicting paths forward.
- **Fast wins**: (1) Fork-companion files (`fork-*.ts`) are zero-conflict — they're new files, not modifications. (2) Config-driven behavior in `agent-orchestrator.yaml` merges with zero conflict. (3) New plugin packages (`packages/plugins/notifier-discord/`) have already proven merge-clean. (4) `fork-skeptic-extension.ts`, `fork-claim-verification.ts`, `fork-utils.ts` are upstream-worthy candidates (~298 LOC).
- **Strategy**: "Companion-first, plugin-second" — isolate fork-specific code into `fork-*.ts` companion files and new plugin packages, avoiding modifications to upstream-touched files. Upstream contributions for genuinely useful fork patterns. Config for behavior where possible.
- **Top priority**: Audit `fork-*.ts` files, classify what is truly fork-only vs upstream-worthy, then restructure to eliminate inline modifications to upstream files.
- **Beads**: `bd-8kel` (Phase 1 plugin extraction), new bead `bd-rstr` (non-conflicting restructure audit)
- **Risks**: Without restructure, fork divergence compounds — every upstream commit touching `lifecycle-manager.ts` or `scm-github/src/index.ts` will create growing merge conflicts.

## Context

Session `worktree_upstream` at `9c5887bc` (jleechanorg/agent-orchestrator fork). Prior session established that zero of ~38 MUST-HAVE upstream commits cherry-pick cleanly — structural divergence is in core files (`lifecycle-manager.ts`, `scm-github/src/index.ts`, `spawn.ts`, `session-manager.ts`) totalling ~2,700 LOC.

This doc covers the **parallel fast path**: what can be restructured RIGHT NOW to reduce upstream merge conflicts, without waiting for the full 8-plugin Phase 1-4 architecture work.

The fork is 827 commits ahead of upstream — it is actively developed, not a static fork. The restructure must enable continued fork development without merge hell.

## Bead index

| Bead | Title | Link |
|------|-------|------|
| `bd-8kel` | Phase 1: Extract lifecycle-skeptic plugin from lifecycle-manager.ts (~500 LOC) | (plugin refactor epic) |
| `bd-3bnk` | Non-conflicting restructure: fork-*.ts audit + config-driven extraction | (tracks this work) |

## Phase A Results (COMPLETED)

**Audit completed 2026-04-22** — all 11 `fork-*.ts` companions audited. Results at `/tmp/fork-audit-report.md`.

| Bucket | LOC | Files | Action |
|--------|-----|-------|--------|
| **A: Upstream-worthy** | 228 | 4 files: `fork-skeptic-extension.ts` (67 LOC), `fork-utils.ts` (36 LOC), `fork-dead-agent.ts` (63 LOC), `fork-reaction-retry-policy.ts` (39 LOC) | Prepare upstream PR candidates |
| **B: Fork-only (companions)** | 1,175 | 6 files | Keep as `fork-*.ts`; extract to plugins |
| **C: Inline candidate** | 87 | `fork-slash-command-routing.ts` | Keep (re-exported via `utils.ts` — public interface) |
| **Total** | **1,490** | **11 files** | Zero dead companions |

**Key findings:**
- Zero dead companions — all 11 are live and imported
- `fork-utils.ts` has 6+ non-lifecycle consumers — most upstream-worthy
- Bucket B is dominant (79% of LOC) — plugin extraction target
- `fork-slash-command-routing.ts` stays as companion (re-exported via `utils.ts`)
- `fork-reaction-retry-policy.ts` and `fork-skeptic-extension.ts` are cleanest upstream candidates

**Tests:** `packages/core/src/__tests__/fork-companion-audit.test.ts` — 42 tests, all passing.

## Work queue

## Work queue

### Phase A: Fork-*.ts Companion Audit

**Goal**: Audit all 11 `fork-*.ts` companion files. Classify each into one of three buckets:

| Bucket | Definition | Action |
|--------|-----------|--------|
| **A: Upstream-worthy** | Fork logic that upstream would accept (genuinely useful, not fork-specific) | Prepare as upstream PR candidate |
| **B: Fork-only (keep as companion)** | Fork-specific logic that cannot go upstream (skeptic integration, AO action logging) | Keep as `fork-*.ts`, ensure it doesn't modify upstream-touched code |
| **C: Inline candidates** | Currently inlined in core files but extractable to fork-*.ts | Extract to companion file to reduce core file divergence |

**Files to audit** (`packages/core/src/fork-*.ts`):
- `fork-skeptic-extension.ts` (59 LOC) — bucket A (upstream-worthy)
- `fork-claim-verification.ts` (257 LOC) — bucket B or A (analyze)
- `fork-utils.ts` (36 LOC) — bucket A
- `fork-slash-command-routing.ts` (88 LOC) — bucket B or C
- `fork-dead-agent.ts` (63 LOC) — bucket A or B
- `fork-reaction-handlers.ts` (149 LOC) — bucket B (fork-specific reactions)
- `fork-reaction-retry-policy.ts` (40 LOC) — bucket A (could generalize)
- `fork-reaction-rfr.ts` (282 LOC) — bucket B (fork-specific RFR logic)
- `fork-lifecycle-manager.ts` (238 LOC) — bucket B (fork-specific)
- `fork-lifecycle-postmerge.ts` (237 LOC) — bucket B
- `fork-lifecycle-kki-override.ts` (38 LOC) — bucket B

**Key question**: Are `fork-lifecycle-manager.ts`, `fork-lifecycle-postmerge.ts`, `fork-lifecycle-kki-override.ts` actually loaded/imported anywhere? If they are dead code, they can be archived.

**Acceptance criteria**:
- All 11 files audited and bucketed
- Each bucket has a clear action (contribute upstream / keep as companion / extract from core)
- Dead companion files identified and archived

**Dependencies**: None — pure file audit, can run in parallel with Phase 1 plugin work.

---

### Phase B: Config-Driven Behavior Audit

**Goal**: Identify fork-specific behavior currently hardcoded in core files that CAN be expressed in `agent-orchestrator.yaml` instead. Config-driven behavior has zero merge conflict.

**Audit targets** (in `packages/core/src/`):
- `lifecycle-manager.ts` — reactions, agentRules injection, notification routing
- `session-manager.ts` — slash command routing, session metadata defaults
- `spawn.ts` — spawn queue limits, project resolution defaults

**What to look for**:
- Hardcoded strings that fork uses to route behavior (e.g., specific reaction names, agent names)
- Conditional logic that could be expressed as a config rule instead
- Behavior enabled by a config flag vs hardcoded boolean

**Example restructure pattern**:
```yaml
# BEFORE (in lifecycle-manager.ts):
if (session.agent === 'codex' && event.type === 'ci-failed') {
  runSkepticReviewReaction(session);
}

# AFTER — config-driven (in agent-orchestrator.yaml):
reactions:
  ci-failed:
    - if: "{session.agent} == 'codex'"
      then: ["run-skeptic-review"]
```

**Acceptance criteria**:
- List of 5+ hardcoded behaviors that could move to config
- Proof-of-concept: one hardcoded behavior extracted to config
- Zero regression — config produces same behavior as hardcoded version

---

### Phase C: New Plugin Package Audit

**Goal**: Identify fork-specific capabilities that exist as inline code but could be new plugin packages (zero conflict — new files).

**Candidate extract targets** (from `lifecycle-manager.ts` inline):
- `logAoAction` call chain → new plugin `lifecycle-ao-action-log` (already designed in `roadmap/nextsteps-plugin-refactor.md`)
- Session event hook → new plugin `lifecycle-session-events`
- MCP mail lifecycle integration → new plugin `lifecycle-mcp-mail`
- `dedup-head-sha-store` → new plugin `lifecycle-head-sha-dedup`

**Candidate from `scm-github/src/index.ts`**:
- Bot author filtering → new plugin `scm-github-bot-filter`
- Rate limit handling → `scm-github-rate-limit`
- Batch enrichment → `scm-github-batch`

**Key principle**: If the code can live in `packages/plugins/<new-plugin>/`, it has zero merge conflict with upstream (upstream doesn't have that directory).

**Acceptance criteria**:
- List of 5+ extractable inline blocks with plugin package targets
- At least 1 new plugin package extracted as proof-of-concept
- Plugin is functional and wired into `agent-orchestrator.yaml`

---

### Phase D: Upstream Contribution Candidate Assessment

**Goal**: Identify fork patterns that are genuinely useful enough to contribute upstream. Upstream contributions = zero future merge conflict.

**Highest-value upstream contribution candidates**:
1. `fork-reaction-retry-policy.ts` (40 LOC) — general retry/backoff pattern, not fork-specific
2. `fork-dead-agent.ts` (63 LOC) — dead agent detection is general
3. `fork-slash-command-routing.ts` (88 LOC) — useful if generalized
4. `fork-skeptic-extension.ts` (59 LOC) — skeptic integration design could benefit upstream

**Assessment criteria**:
- Does upstream have equivalent functionality? (if yes → don't contribute)
- Is the pattern general enough for upstream acceptance?
- Does the fork maintainer (jleechanorg) want to maintain this in upstream?

**Acceptance criteria**:
- All 4 candidates assessed with explicit "contribute upstream" or "keep fork-only" decision
- For "contribute upstream" candidates: fork creates a clean cherry-pick with no fork dependencies
- PR draft prepared for at least 1 upstream contribution candidate

---

### Phase E: Inline Modification Reduction (Core File Divergence Audit)

**Goal**: For each upstream-touched core file, identify what inline modifications could be moved to fork-*.ts companions, reducing the diff surface.

**Target files**:
- `lifecycle-manager.ts` — fork has ~955 extra LOC over upstream (3,032 vs 2,077)
- `scm-github/src/index.ts` — fork has ~1,859 extra LOC (2,924 vs 1,065)
- `spawn.ts` — fork has ~106 extra LOC (490 vs 384)
- `session-manager.ts` — fork has ~112 extra LOC (2,941 vs 2,829)

**The pattern to achieve**:
```
# upstream/file.ts — 0 modifications, no merge conflict
# packages/core/src/fork-some-feature.ts — companion file, no merge conflict
# packages/plugins/fork-plugin/ — plugin package, no merge conflict

# Config in agent-orchestrator.yaml — no code changes
```

**Acceptance criteria**:
- For `lifecycle-manager.ts`: identify 300+ LOC that can be moved to companions/plugins
- For `scm-github/src/index.ts`: identify 500+ LOC that can be moved to companions/plugins
- Net result: upstream cherry-pick creates <100 lines of conflict in these files

---

## PR / merge state

- PR #489: OPEN — `[agento] feat(upstream-port): Discord rate-limit fixes + remove desktop notifications`
- PR #488: OPEN — `[agento] fix(skeptic): dry-run exits non-zero on unparseable LLM output`
- PR #487: OPEN — `[agento] fix: suppress PR/push instructions when skipPrBoilerplate=true`
- PR #486: OPEN — `[agento] fix: AO worker launch ergonomics from worldarchitect loop evidence`
- PR #485: OPEN — `[agento] fix: CodeRabbit Chat requested code changes`
- PR #483: OPEN — `[agento] 📝 CodeRabbit Chat: Implement requested code changes`
- PR #482: OPEN — `[agento] fix: add HERMES_HOME to AO config discovery path`
- PR #481: OPEN — `[agento] feat: consolidated ao-install.sh worker-node install script`
- PR #479: OPEN — `[agento] feat(ao-library): AO technique library — SR-prtype as safe default`

No PRs referenced in this block's work queue.

## Learnings pointer

- `~/roadmap/learnings-2026-04.md` — section `2026-04-22 — non-conflicting code restructure audit`

## Roadmap pointer

- Updated `roadmap/README.md` — Recent activity (rolling)