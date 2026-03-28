# 7-Green Enforcement Gaps — Audit 2026-03-28

**Created**: 2026-03-28
**Trigger**: 24h merged PR audit — 9/22 PRs (41%) were not 6-green at merge time
**Related**: [zero-touch-6green-rate.md](zero-touch-6green-rate.md), [harness-engineering-v2.md](harness-engineering-v2.md)

## Executive Summary

The 7-green gates exist in documentation (CLAUDE.md, repo CLAUDE.md) but **the entire enforcement layer is non-functional**:

1. **Skeptic Gate is broken** — LLM evaluation never runs (both Codex and Claude fail in CI). Every PR gets `VERDICT: SKIPPED` → `exit 0` → CI shows "success". The gate has been silently disabled for ALL recent PRs.
2. **Zero branch protection** — `main` has no required status checks, no required reviewers, no restrictions. All gate logic is advisory-only.
3. **SKIPPED = PASS** — The skeptic-run action treats infrastructure failure as success, creating a permanent bypass.
4. **All 7 PRs without CR APPROVED were manually merged by jleechan2015** — no auto-merge was involved.

**Net effect**: The 7-green system is documentation-only. Nothing enforces it.

## Audit Data (2026-03-27 15:00Z — 2026-03-28 15:00Z)

### PRs at 7/7 green (5/22 = 23%)
| PR | Title | All gates |
|---|---|---|
| #231 | feat: design docs on PR open | All CI pass, CR APPROVED, Skeptic pass |
| #223 | feat: skeptic Phase 2 | All CI pass, CR APPROVED, Skeptic pass |
| #234 | fix: dedup send-to-agent | All CI pass, CR APPROVED, Skeptic pass |
| #233 | fix(skeptic): remove --no-input | All CI pass, CR APPROVED, Skeptic pass |
| #232 | feat: periodic MCP mail poll | All CI pass, CR APPROVED, Skeptic pass |

### PRs at 6/7 green (8/22 = 36%) — CR COMMENTED with auto_verdict
| PR | Missing gate | Notes |
|---|---|---|
| #250, #251, #210, #237, #220 | Gate 3: CR COMMENTED w/ auto_verdict | Acceptable per CLAUDE.md CR automated verdict rule |
| #236 | Gate 3: CR DISMISSED | Was APPROVED then dismissed for re-review |
| #239 | Gates unclear | No checks on HEAD (possibly rebased) |
| #235 | Gate 3: CR APPROVED | Actually 7/7 (bead-only PR) |

### PRs NOT 6-green (9/22 = 41%)

#### Severity: CRITICAL — PR #254 (3/7 green)
- **Gate 1 FAIL**: Test + Lint CI failures on HEAD
- **Gate 3 FAIL**: CR DISMISSED
- **Gate 5 FAIL**: 6 unresolved threads including CRITICAL severity
- **Beads**: bd-7jia, bd-jp7q

#### Severity: HIGH — PR #252 (5/7 green)
- **Gate 1 FAIL**: Lint failure on HEAD
- **Gate 5 FAIL**: 8 unresolved threads including HIGH severity
- **Bead**: bd-mnkv

#### Severity: MEDIUM — 7 PRs without CR APPROVED
PRs #255, #249, #240, #242, #243, #247, #216
- **Gate 3 FAIL**: CR=COMMENTED, no auto_verdict
- All other gates appear to pass
- **Bead**: bd-vpzh

## Root Cause Analysis

### Gap 1: Skeptic Gate false-positives (bd-kvvx)
**What**: Skeptic Gate passes PRs where CR=COMMENTED (not APPROVED).
**Why**: The skeptic prompt likely checks for "no CHANGES_REQUESTED" rather than "has APPROVED". COMMENTED is the default CR state after any review — it's not approval.
**Impact**: Gate 3 is effectively unenforced. 7 PRs slipped through.
**Fix**: Update skeptic-cron.yml to explicitly require `state: APPROVED` from CR, not just absence of `CHANGES_REQUESTED`.

### Gap 2: CI failures don't block merge (bd-jp7q)
**What**: PR #254 merged with Test + Lint failures on HEAD.
**Why**: Branch protection may not be configured with required status checks, or the merger has admin bypass.
**Impact**: Gate 1 is enforceable but not enforced.
**Fix**: Configure branch protection to require `Lint`, `Test`, `Typecheck` as required status checks. Remove admin bypass for merge.

### Gap 3: No atomic pre-merge validation
**What**: Each gate is checked independently. No single gate checks all 7 atomically before allowing merge.
**Why**: The approved-and-green reaction checks some conditions but doesn't run the full 7-green check before executing merge.
**Impact**: Race conditions and partial checks allow non-green merges.
**Fix**: Add a required GitHub Actions check (`merge-gate`) that runs on `pull_request` and blocks merge unless all 7 pass.

### Gap 4: Unresolved comments don't block merge
**What**: PRs with HIGH/CRITICAL unresolved review threads can be merged.
**Why**: GitHub doesn't natively enforce "all threads resolved" as a branch protection rule. The Skeptic Gate is supposed to check this but may be failing.
**Fix**: The `merge-gate` action should query `reviewThreads` via GraphQL and fail if unresolved non-nit threads exist.

## Proposed Improvements (Priority Order)

### P0: Fix Skeptic Gate CR check (bd-kvvx)
- **Effort**: Small (prompt change in skeptic-cron.yml)
- **Impact**: Prevents gate 3 bypass for all future PRs
- **Action**: Update skeptic to require `state: APPROVED` from CR bot, not just absence of CHANGES_REQUESTED

### P0: Add required status checks to branch protection
- **Effort**: Small (GitHub settings change)
- **Impact**: Prevents gate 1 bypass — CI failures block merge
- **Action**: `gh api repos/jleechanorg/agent-orchestrator/branches/main/protection --method PUT` with required checks

### P1: Create merge-gate GitHub Action
- **Effort**: Medium (new workflow)
- **Impact**: Atomic 7-green enforcement before merge
- **Design**:
  - Trigger: `pull_request` (types: opened, synchronize, reopened)
  - Checks all 7 gates, posts structured pass/fail
  - Required status check — blocks merge if any gate fails
  - Replaces ad-hoc checks scattered across skeptic + reactions

### P1: Fix Skeptic Gate unresolved-comment check
- **Effort**: Small (prompt or script change)
- **Impact**: Prevents gate 5 bypass
- **Action**: Add GraphQL `reviewThreads` isResolved check to skeptic

### P2: Audit and fix auto-merge reaction conditions
- **Effort**: Medium
- **Impact**: Prevents reaction from firing merge when not all gates pass
- **Action**: Review `approved-and-green` reaction in agent-orchestrator.yaml

### P2: Post-merge audit cron
- **Effort**: Small (new cron job)
- **Impact**: Detection, not prevention — alerts when non-green PRs are merged
- **Action**: Daily cron checks last 24h merges, posts Slack alert for any < 6-green

## Metrics

| Metric | Baseline (2026-03-28) | Target |
|---|---|---|
| 7-green rate at merge | 23% (5/22) | 80%+ |
| 6-green rate at merge | 59% (13/22) | 95%+ |
| PRs merged with CI failure | 1/22 (4.5%) | 0% |
| PRs merged without CR APPROVED | 9/22 (41%) | 0% |
| PRs merged with unresolved HIGH+ comments | 2/22 (9%) | 0% |

## Auditor Findings — Deep Dive

### PR #254: Live bug in production (process.cwd())
The auditor confirmed a **real bug**: `worktree-git.ts:75` uses `process.cwd()` instead of `homedir()` for phase-2 scan. Under launchd (cwd=`/`), the loop is immediately false — phase-2 recovery is silently disabled for all daemon-context worktree operations. Tests pass because mocks accept any `-C` dir argument.

### PR #252: Partial goal achievement + dead code
- The PR's stated goal (strip `\u003c` CURSOR_SUMMARY) is NOT achieved — regex only matches decoded `<!--` form
- `verdict-utils.ts` is dead code: no production import, wrong SKIPPED→yellow mapping (production uses red)
- Tests validate a local copy of `getVerdictColor`, not the production code
- 3 of 8 unresolved comments were obsolete (step removed before merge), 5 are real

### CR Gap: Skeptic infrastructure completely broken
- All 7 "CR-not-APPROVED" PRs had Skeptic Gate = `success` with `VERDICT: SKIPPED`
- Both LLM backends fail: Codex not in CI, `claude --print` fails (auth/binary)
- `main` branch has **zero branch protection** — "Branch not protected" from API
- All merges were manual by `jleechan2015`, not auto-merge

## Beads Created (11 total)

### P0 — System-breaking
- **bd-1lni**: CRITICAL: Skeptic Gate infrastructure broken — VERDICT: SKIPPED on all PRs
- **bd-io8q**: CRITICAL: main branch has zero branch protection — any merge allowed
- **bd-0cfv**: Skeptic Gate treats VERDICT: SKIPPED as success (exit 0) — should be fail-closed
- **bd-vpzh**: Systemic: 7 PRs merged without CR APPROVED — merge gate not enforcing gate 3
- **bd-kvvx**: Skeptic Gate false-positive: PASS on PRs missing CR APPROVED

### P1 — Live bugs in production
- **bd-7jia**: PR #254 merged with Test+Lint failure and CRITICAL unresolved comments
- **bd-jp7q**: Merge executor does not block on CI failures
- **bd-01lq**: worktree-git.ts process.cwd() bug silently disables phase-2 fallback in daemon context
- **bd-mnkv**: PR #252 merged with Lint failure and HIGH severity unresolved comments

### P2 — Code quality / dead code
- **bd-b5et**: verdict-utils.ts is dead code with wrong getVerdictColor mapping
- **bd-18el**: generate-pr-design-docs.mjs regex misses literal \u003c CURSOR_SUMMARY
