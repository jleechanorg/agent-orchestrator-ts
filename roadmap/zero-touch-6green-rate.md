# Zero-Touch 6-Green Rate Improvement Plan

**Created**: 2026-03-24
**Updated**: 2026-03-27
**Metric**: % of merged PRs that reach 6-green with zero human commits
**Baseline**: 16% (7/43 over last 7 days as of 2026-03-24)
**Current**: 25% (14/55 over last 7 days as of 2026-03-25)
**Target**: 50%+ within 2 weeks

## Session Results (2026-03-24 17:00Z — 2026-03-25 04:30Z, ~12h)

- **22 PRs merged** (12 original open + 10 new from workers)
- **0 PRs remaining open** (queue fully cleared)
- **6-green rate**: 16% → 25% (+9pp)
- **New merges zero-touch rate**: 58% (7/12 new merges were fully autonomous)
- **Phase 1 landed**: bd-8se (worktree cleanup), bd-5gl (merge executor)
- **Phase 2 deployed**: agentRules `@coderabbitai full review` (bd-ara.4)
- **Harness improvements**: CR silent fallback rule, codex subagent review
- **Workers spawned**: 9 (ao-772-778, ao-805, ao-807)
- **Biggest friction**: CR re-approval loop (7h stalls on #155, #166)

## Problem

84% of merged PRs required human intervention. The AO pipeline breaks at
predictable points: workers die without replacement, reactions misfire,
reviews don't flip, and nothing auto-merges even when green.

## Investigation findings (2026-03-24)

- **27 locked worktrees** from killed sessions block backfill respawn (bd-8se)
- **Reaction misfire** (bd-8r5/bd-ljw): changes-requested fires when reviewDecision != CHANGES_REQUESTED
- **No merge executor** (bd-5gl): workers post "PR is green" but nothing merges
- **listOpenPRs uses REST** — GraphQL exhaustion is NOT a backfill blocker (confirmed)
- **CI cascading failures**: main drift causes rebase storms across all open PRs

## Phase 1: Critical path fixes (expected +30-40% lift)

### bd-8se — Clean stale locked worktrees before respawning [P1]
- **Impact**: +10% — unblocks backfill for orphaned PRs
- **Root cause**: session kill doesn't clean worktrees; git refuses second worktree on same branch
- **Fix**: session-manager.kill() must unlock+remove worktree; backfill should pre-check for stale locks
- **One-time cleanup**: remove 27 existing stale locked worktrees

### bd-ljw — Add state guard to changes-requested reaction [P1]
- **Impact**: +5-10% — stops workers wasting cycles on false reactions
- **Root cause**: executeReaction() fires without re-verifying reviewDecision
- **Fix**: verify `reviewDecision === "changes_requested"` in executeReaction() before dispatching
- **Location**: lifecycle-manager.ts ~line 465

### bd-5gl — Merge executor for green PRs [P0]
- **Impact**: +15-20% — the single biggest gap
- **Root cause**: workers correctly identify 6-green but have no merge authority
- **Fix**: after posting green signal, run `gh pr merge --squash --admin`; agentRules already instruct this but workers don't reliably execute it (bd-weav: --auto delegates to GitHub merge queue, merged_by=null, breaking zero-touch rate)
- **Approach**: add explicit merge step to approved-and-green reaction handler

## Phase 2: Review loop fixes (expected +10-15% lift)

### bd-ara.4 — Workers can't flip CHANGES_REQUESTED to APPROVED [P0]
- Workers fix code and push, but CR stays CHANGES_REQUESTED
- Fix: after push, post `@coderabbitai full review` (not `all good?` which triggers chat, not review)
- Update agentRules to use `full review` instead of `all good?`

### bd-ara.1 — Workers don't resolve inline comment threads [P0]
- Workers fix code but threads stay unresolved in GitHub
- Fix: use GraphQL minimizeComment or resolve thread API after fixing each comment
- Alternative: document resolution in PR description (current workaround)

## Phase 3: Shepherd and verification (expected +5-10% lift)

### bd-y5v.1 — Green loop shepherd [P0]
- Recurring 10m loop that picks nearest-to-green PR and drives it to merge
- Prioritizes: APPROVED+clean > APPROVED+conflict > CHANGES_REQUESTED
- Already partially implemented, needs activation

### bd-qw6 — Skeptic agent for independent verification [P1]
- Separate agent with inverted incentive: rewarded for finding gaps
- Catches false-green claims before merge
- Prevents the "16% are zero-touch but are they actually correct?" question

## Success metrics

| Metric | Baseline | Phase 1 target | Phase 2 target |
|---|---|---|---|
| Zero-touch rate | 16% | 45-55% | 60-70% |
| Stalled PRs (>1hr, no worker) | 5 | 0-1 | 0 |
| Avg time to merge (agent PRs) | ~8h+ | <2h | <1h |
| Locked worktrees | 27 | 0 | 0 (prevented) |

## Dependencies

- bd-85r (P0, in flight ao-772): startup race must be fixed for workers to survive long enough
- bd-6ql (P0, in flight ao-773): tmux mismatch must be fixed for reliable session tracking

---

## PR Staleness Triage Policy (bd-ara.stale)

**Problem**: PRs stall silently at 6-green without any indication of why. Workers die, reactions misfire, and CI runs but nothing merges. By the time a human notices, hours of progress have been lost.

**Policy** (enforced via `scripts/ao-doctor-monitor.sh` and `scripts/check-pr-worker-coverage.sh`):

| Concern | Threshold | Action |
|---|---|---|
| Fresh PR | < 3h | No flag |
| Stale PR | ≥ 3h | WARN in monitor + coverage script |
| Stale + uncovered | ≥ 3h, no session | FAIL in coverage script; trigger respawn |
| Missing `createdAt` | — | Hard guardrail: FAIL/block until fixed |

**Implementation**:
- `ao-doctor-monitor.sh`: runs `check_pr_age()` in Phase 1 — fetches `createdAt` for all open PRs, displays age in hours in terminal + Slack digest, flags >3h as stale concern, FAILS if `createdAt` missing
- `check-pr-worker-coverage.sh`: exits non-zero if any uncovered PR is >3h stale; exits code 2 if `createdAt` is missing from any PR
- `skeptic-cron.yml`: logs PR age and staleness on every 30-min cycle for audit trail

**Triage flow**:
```
PR age < 3h → no action needed
PR age ≥ 3h + covered → WARN in monitor, include in Slack digest
PR age ≥ 3h + UNCOVERED → FAIL coverage, respawn worker
PR missing createdAt → hard block (ci: ao-doctor; cov: exit 2)
```

**Env vars**: `AO_DOCTOR_STALE_HOURS` (default 3h), `STALE_HOURS` (coverage script)
