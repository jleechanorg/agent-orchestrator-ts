# Audit: 7 PRs Merged Without CodeRabbit Review (2026-04-04)

**Date:** 2026-04-04
**Governance Failure:** CodeRabbit review not enforced before merge
**Root Cause:** The 7 PRs merged without CodeRabbit review because jleechan2015 manually merged them directly, bypassing `skeptic-cron.yml` entirely. This incident was not caused by a logic bug in the Gate-3 condition — that condition was already correctly using `&&` (AND) in both `skeptic-cron.yml` and `skeptic-gate-reusable.yml`. The condition correctly blocked zero-signal cases via the `continue` path. The incident was a governance bypass, not a logic failure.

This PR updates the Gate-3 echo message for clarity and adds this audit document for governance record.

---

## PRs Affected

| PR # | Title | Merged At | Merged By |
|------|-------|-----------|-----------|
| #373 | `[agento] fix(harness): add churn-guard PreToolUse hook to block duplicate-file PRs` | 2026-04-04T07:07:43Z | jleechan2015 |
| #374 | `[agento] fix(metadata-updater): use BASH_REMATCH[2] not [1] in env-strip regex` | 2026-04-04T07:07:43Z | jleechan2015 |
| #375 | `[agento] fix(evidence-gate): accept both **label**: and **label:** Markdown formats` | 2026-04-04T07:07:43Z | jleechan2015 |
| #376 | `[agento] docs: manager evolve loop architecture design` | 2026-04-04T07:07:43Z | jleechan2015 |
| #377 | `[agento] test(core): stalled-worker-auditor unit tests` | 2026-04-04T07:07:43Z | jleechan2015 |
| #378 | `[agento] feat(core): implement manager evolve loop config + prompt injection` | 2026-04-04T07:07:43Z | jleechan2015 |
| #379 | `[agento] fix: refactor zombie sweep detection to use branch names (wc-zsw)` | 2026-04-04T07:07:43Z | jleechan2015 |

**Total:** 7 PRs merged within the same minute (07:07:43Z) — all by jleechan2015 directly, no CodeRabbit reviews.

---

## Root Cause

`skeptic-cron.yml` Gate 3 fallback path (lines ~168-197):

```bash
# Gate-3 check (used when LATEST_CR = "none")
if [ "$CR_STATUS" = "success" ] && [ "$CR_APPROVE_COMMENT" = "APPROVED" ]; then
    echo "  [GATE-3] CR=APPROVED(status+comment)"
```

When `LATEST_CR = "none"` (no formal review submitted), the fallback checks CR status on the commit AND an `[approve]` comment after HEAD commit. If both signals are absent, the else branch increments `SKIPPED_NOT_6GREEN` and calls `continue` — correctly blocking the PR.

**Note:** The 7 PRs were merged by direct manual push by jleechan2015, bypassing the workflow entirely. The Gate-3 condition logic was already correct with `&&` — this PR changes only the echo message for clarity.

**Fix applied (this PR):**
- Gate-3 echo message updated from `"status+comment"` to `"status AND comment"` for clarity

---

## Fix Details

**File:** `.github/workflows/skeptic-cron.yml`
**Lines changed:** 191 (Step 1 Gate 3), 387 (Step 3 Gate 3)

| Location | Change |
|----------|--------|
| Step 1 Gate 3 (line 191) | Echo message: `"status+comment"` → `"status AND comment"` |
| Step 3 Gate 3 (line 387) | Echo message: `"status+comment"` → `"status AND comment"` |

No boolean logic was changed — the `&&` condition was already in place.

---

## Impact

- This PR updates Gate-3 echo message for clarity; no boolean logic was changed
- The `&&` (AND) condition in `skeptic-cron.yml` was already consistent with `skeptic-gate-reusable.yml`
- The 7 PRs bypassed the workflow via direct manual merge, not via a logic gap in Gate-3

---

## Related Commits

- `9ad4e43a` — Governance layer design doc (PR #453)
- `cd91a3a7` — Hook disabled Apr 3 (hook breakage preceded incident)
- `37a727e1` — Fail-closed tokenization added Apr 17
- `4bd80f53` — Chained command guard added Apr 17

---

## Metadata

- **Branch:** `feat/audit-and-fix-governance-failure-7-prs-merged-without-cr-app`
- **Fix commit:** `4ca06ee1`
- **Author:** ao-novel-daily