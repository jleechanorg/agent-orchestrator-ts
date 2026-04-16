# Real-Time Governance Layer for the Evolve Loop

**Design doc:** `roadmap/real-time-governance-layer.md`
**Bead:** _(create after review)_
**Author:** Hermes (reviewing Archon coleam00/Archon + AO gap analysis)
**Date:** 2026-04-15
**Status:** Draft — for review

---

## Context

Coleam00's Archon "dark factory" ([repo](https://github.com/coleam00/Archon), [video](https://www.youtube.com/watch?v=Xg0tNz9pICI)) implements a governance layer as plain-English markdown files (`mission.md`, `factory-rules.md`) that Archon workflows read at runtime. The files are version-controlled, human-editable, and loaded by the system without code changes.

The AO evolve loop (`orchestrator-prompt.ts` Phase 1–8) is architecturally superior — event-driven, parallel, with independent skeptic verification and an 8-phase autonomous cycle. However, governance is encoded in two ways that require code changes to modify:

1. **IMPLICIT_DENY_LIST** — hardcoded array in `orchestrator-prompt.ts` (`gh pr merge`, `git reset --hard`, etc.)
2. **`evolveLoop.autonomousFixScopes` / `blockedScopes`** — config-based allow/deny, but requires editing `agent-orchestrator.yaml` and PRing it

This design adds **runtime-readable governance files** that the evolve loop loads on every OBSERVE cycle, with zero mandatory human checkpoints.

---

## Goals

1. Governance files are editable without code changes or PRs
2. System loads them on every OBSERVE cycle — no restart required
3. Human review is always optional; artifacts are byproducts, not gates
4. Existing evolve loop behavior is unchanged when files are absent (backward compatible)
5. Artifacts (skeptic verdict, evidence bundle) are written for the record but never block the loop

---

## Non-Goals

- No mandatory human approval anywhere in the loop
- No blocking gates that pause execution waiting for human input
- No governance files that are required to exist — system proceeds without them

---

## Design

### File Locations

```text
~/.ao-evolve-knowledge/<projectId>/
  GOVERNANCE.md          ← in-scope: behaviors the loop must not do
  SCOPE.md               ← in-scope: what issues/features are accepted or rejected
  prs/<prNumber>/
    skeptic-verdict.md   ← written after skeptic runs (optional human read)
    evidence-bundle.md   ← written after evidence bundle (optional human read)
```

Files are stored under `~/.ao-evolve-knowledge/` (not the repo) so they can be edited without PRs. The evolve loop reads them from the filesystem, not git.

> **Implementation note:** Treat `~` as documentation shorthand; resolve to an absolute home-directory path (for example, `${HOME}/.ao-evolve-knowledge/...`) before file I/O. Do not treat `~` as a literal path component.

### GOVERNANCE.md

Plain English. Lists behaviors the loop must never do, in addition to `IMPLICIT_DENY_LIST`.

Example:

```markdown
# Governance — What the AO Loop Must Never Do

## Hard Constraints

- Never merge a PR without CI green
- Never close a PR without human approval
- Never modify files in `.github/` without explicit human directive
- Never delete a worktree without the session being terminal (merged or closed)
- Never override `agentRules` via autonomous fix — only human-initiated edits

## Rate Limits

- Maximum 5 PRs open per project at any time
- Maximum 3 autonomous fix dispatches per evolve cycle
- If GitHub API quota < 500 remaining, skip MEASURE phase

## Escalation Triggers

The loop escalates to human notification (not approval) when:
- A PR has been open > 48h with no activity
- CI has failed 5+ consecutive times on the same PR
- A stuck worker is detected and the agent-stuck reaction fails to recover within 2 cycles
```

### SCOPE.md

Defines what kinds of issues the loop will and will not act on. Inspired by Archon's `mission.md`.

Example:

```markdown
# Scope — What the AO Loop Will and Won't Handle

## In Scope

- Bug fixes from GitHub issues
- Feature implementations from accepted issues
- CI failures on existing PRs
- Review comment resolution
- Merge conflict resolution
- Dependency updates (security patches only)

## Out of Scope

- Major architecture changes (must be human-directed)
- Changes to authentication or payment systems
- Adding or removing system dependencies
- Schema migrations requiring data migration planning
- Any issue labeled `blocked` or `externally-blocked`

## Quality Bar

- PRs must pass: CI green + CodeRabbit approval + skeptic VERDICT
- PRs must not exceed 500 lines changed (split large PRs)
- PRs must include test coverage for non-trivial logic
```

### skeptic-verdict.md

Written to `~/.ao-evolve-knowledge/<projectId>/prs/<prNumber>/skeptic-verdict.md` after the skeptic agent runs. Never blocks the loop.

Format:

```markdown
# Skeptic Verdict — PR #<prNumber>

**Generated:** <ISO timestamp>
**Verdict:** PASS | FAIL | SKIPPED
**Model:** <model used>

---

## Summary

<one paragraph: what the skeptic evaluated and why>

## Findings

| Check | Result | Detail |
|-------|--------|--------|
| Evidence bundle plausibility | PASS | All claims mapped to artifacts |
| CI failure root cause addressed | PASS | Root cause identified and fixed |
| Review comments addressed | PASS | All threads resolved |
| No new issues introduced | FAIL | `src/auth.ts` has potential null deref — see below |

## Rebuttals

- **Implementation claims**: Skeptic agrees root cause was addressed (CI log shows `ENOENT` fixed in `config-loader.ts`)
- **Evidence sufficiency**: Skeptic notes evidence bundle URL is unreachable — recommend re-upload

## Recommendation

BLOCK merge until `src/auth.ts` null deref is addressed.
```

### evidence-bundle.md

Written to `~/.ao-evolve-knowledge/<projectId>/prs/<prNumber>/evidence-bundle.md` after evidence bundle generation. Format mirrors the Evidence Bundle v2 spec but as a plain markdown artifact.

### Integration Points

> **Note:** The evolve loop runs phases 1–8 as defined in `orchestrator-prompt.ts`. The governance load described below is **Phase 0 — a pre-OBSERVE preload step** that runs before every OBSERVE cycle and does not alter the existing phase numbering.

#### Phase 1 (OBSERVE)

At the top of OBSERVE, the orchestrator prompt already includes the evolve loop instructions. Add:

```markdown
### Phase 0: LOAD GOVERNANCE (before every OBSERVE cycle)

Read ~/.ao-evolve-knowledge/<projectId>/GOVERNANCE.md and SCOPE.md if they exist.
Incorporate their constraints into this cycle's decisions.
If GOVERNANCE.md is absent, fall back to IMPLICIT_DENY_LIST (hardcoded).
If SCOPE.md is absent, proceed without scope filtering.

These files are loaded from the filesystem, not git. Edit them directly — no PR required.
```

> **Implementation note:** Resolve `~/.ao-evolve-knowledge/` to an absolute home-directory path before file I/O (e.g. `${HOME}/.ao-evolve-knowledge/...`).

#### Skeptic Verdict Writing

After the skeptic agent returns, before writing the verdict to the session metadata store, also write `skeptic-verdict.md` to the artifact path. The merge gate continues to use the structured data from the skeptic; the markdown file is an optional record.

#### Evidence Bundle Writing

After evidence bundle generation in the `evidence-bundle.ts` module, write the markdown artifact alongside the structured artifact. Existing CI gate behavior is unchanged.

---

## Changes Required

### New files

| File | Purpose |
|------|---------|
| `packages/core/src/evolve-loop-governance.ts` | Reads and parses GOVERNANCE.md + SCOPE.md; provides typed constraints to the evolve loop |
| `packages/core/src/evolve-loop-artifacts.ts` | Writes skeptic-verdict.md and evidence-bundle.md as markdown artifacts |

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/orchestrator-prompt.ts` | Inject Phase 0 governance load into evolve loop section |
| `packages/core/src/skeptic-reviewer.ts` | Call artifact writer after skeptic verdict |
| `packages/core/src/evidence-bundle.ts` | Call artifact writer after bundle generation |

### Config changes

None. The system falls back to existing `IMPLICIT_DENY_LIST` and `autonomousFixScopes` behavior when governance files are absent.

---

## Adoption Path

1. **Phase 1:** Add `evolve-loop-governance.ts` and `evolve-loop-artifacts.ts`. Write files to disk. Existing behavior unchanged.
2. **Phase 2:** Update `orchestrator-prompt.ts` to inject Phase 0 load. System now reads governance files.
3. **Phase 3:** Populate `~/.ao-evolve-knowledge/<projectId>/GOVERNANCE.md` and `SCOPE.md` for monitored projects. No PR required.
4. **Phase 4:** Existing artifacts (skeptic verdicts, evidence bundles) become human-readable markdown in addition to structured data.

---

## Relationship to Archon

| | Archon | AO (this design) |
|---|---|---|
| Governance file format | YAML workflows + markdown | Markdown only |
| Where governance lives | Repo (`.archon/`) | FS (`~/.ao-evolve-knowledge/`) |
| Edit without PR | No | Yes |
| Human review required | ⚠️ Approval nodes in YAML DAG | No — always optional |
| Workflow encoded | YAML DAG | Not encoded (loop is code, not YAML) |
| Scope file | `mission.md` | `SCOPE.md` (equivalent) |
| Quality gates | YAML-defined deterministic steps | Skeptic + merge gate (structurally stronger) |

The AO's skeptic agent + 7-condition merge gate is architecturally superior to Archon's holdout pattern (same LLM, no adversarial structure). This design adds the governance ergonomics Archon demonstrates without compromising autonomy.

---

## Open Questions

1. Should governance files be synced to git as well as stored on FS? (Would enable PR review of governance changes but requires human action to sync)
2. Should `GOVERNANCE.md` / `SCOPE.md` changes emit a Slack notification? (Non-blocking notification only)
3. Should there be a `ao governance` CLI command to edit/view governance files?
