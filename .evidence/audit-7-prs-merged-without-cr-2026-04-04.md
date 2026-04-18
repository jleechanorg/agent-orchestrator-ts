# Audit: 7 PRs Merged Without CodeRabbit Review (2026-04-04)

**Date:** 2026-04-04
**Governance Failure:** CodeRabbit review not enforced before merge
**Root Cause:** Gate 3 fallback path in `skeptic-cron.yml` used `&&` instead of `||`, requiring both CR status AND approval comment — allowing PRs through when neither was present.

---

## PRs Affected

| PR # | Title | Merged At | Merged By |
|------|-------|-----------|-----------|
| #373 | `[agento] fix(harness): add churn-guard PreToolUse hook to block duplicate-file PRs` | 2026-04-04T07:07:43Z | jleechan2015 |
| #374 | `[agento] fix(metadata-updater): use BASH_REMATCH[2] not [1] in env-strip regex` | 2026-04-04T07:07:43Z | jleechan2015 |
| #375 | `[agento] fix(evidence-gate): accept both **label**: and **label:** markdown formats` | 2026-04-04T07:07:43Z | jleechan2015 |
| #376 | `[agento] docs: manager evolve loop architecture design` | 2026-04-04T07:07:43Z | jleechan2015 |
| #377 | `[agento] test(core): stalled-worker-auditor unit tests` | 2026-04-04T07:07:43Z | jleechan2015 |
| #378 | `[agento] feat(core): implement manager evolve loop config + prompt injection` | 2026-04-04T07:07:43Z | jleechan2015 |
| #379 | `[agento] fix: refactor zombie sweep detection to use branch names (wc-zsw)` | 2026-04-04T07:07:43Z | jleechan2015 |

**Total:** 7 PRs merged within the same minute (07:07:43Z) — all by jleechan2015 directly, no CodeRabbit reviews.

---

## Root Cause

`skeptic-cron.yml` Gate 3 fallback path (lines ~168-197):

```bash
# OLD (broken — required BOTH)
if [ "$CR_STATUS" = "success" ] && [ "$CR_APPROVE_COMMENT" = "APPROVED" ]; then
    echo "  [GATE-3] CR=APPROVED(status+comment)"
```

When `LATEST_CR = "none"` (no formal review submitted), the fallback checked CR status on the commit AND an `[approve]` comment after HEAD commit. If **both** were absent (`CR_STATUS=none`, `CR_APPROVE_COMMENT=none`), the `&&` condition failed but the else branch only logged — it didn't block. The PR proceeded to merge.

**Fix applied:**
```bash
# NEW (correct — requires EITHER)
if [ "$CR_STATUS" = "success" ] || [ "$CR_APPROVE_COMMENT" = "APPROVED" ]; then
    echo "  [GATE-3] CR=APPROVED(status OR comment)"
```

---

## Fix Details

**File:** `.github/workflows/skeptic-cron.yml`
**Lines changed:** 191, 387

| Location | Old | New |
|----------|-----|-----|
| Step 1 Gate 3 (line 191) | `&&` | `\|\|` |
| Step 3 Gate 3 (line 387) | `&&` | `\|\|` |

**Also updated echo:** `CR=APPROVED(status+comment)` → `CR=APPROVED(status OR comment)` to reflect the new logic.

---

## Impact

- Before fix: PRs with zero CR engagement (no review, no status, no comment) could pass Gate 3
- After fix: PRs require at minimum a CR status=success **OR** an `[approve]` comment — either signals CR has engaged
- Formal CR APPROVED review remains the primary path; fallback is now meaningful

---

## Related Commits

- `9ad4e43a` — Governance layer design doc (PR #453)
- `cd91a3a7` — Hook disabled Apr 3 (hook breakage preceded incident)
- `37a727e1` — Fail-closed tokenization added Apr 17
- `4bd80f53` — Chained command guard added Apr 17

---

## Metadata

- **Branch:** `feat/audit-and-fix-governance-failure-7-prs-merged-without-cr-app`
- **Fix commit:** (pending)
- **Author:** ao-novel-daily