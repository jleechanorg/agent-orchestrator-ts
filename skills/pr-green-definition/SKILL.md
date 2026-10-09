---
name: pr-green-definition
description: Canonical 6-green PR merge criteria, PR status check pattern, PR freeze discipline, and admin merge protocol
type: policy
---

# PR "Green" Definition (6-Green)

**Was "7-Green" until this repo's own Skeptic PR-gating automation (`skeptic-gate.yml`, `skeptic-cron.yml`, `test.yml`'s trigger job) was retired in PR #773 — Skeptic PASS is no longer a required gate here.** See `CLAUDE.md`'s "Skeptic Architecture" note for what still applies (consumer-repo templates, the `ao skeptic verify` CLI itself).

A PR is "green" (merge-ready) when **all 6 conditions** hold:

| # | Condition | Verification |
|---|---|---|
| 1 | **CI passing** | All checks show SUCCESS |
| 2 | **No merge conflicts** | mergeable: MERGEABLE |
| 3 | **CodeRabbit APPROVED** | CR must post explicit APPROVED review state (configured via `.coderabbit.yaml` `approve=true`); COMMENTED alone does not pass |
| 4 | **Bugbot clean** | Zero error-severity comments from cursor[bot] |
| 5 | **All inline comments resolved** | Zero unresolved non-nit inline review comments |
| 6 | **Evidence review passed** | evidence-review-bot APPROVED or evidence-gate CI passed |

**Pre-merge verification is MANDATORY.** Before executing any merge command (`gh pr merge`, `gh api .../merge`), verify all 6 gates pass. If ANY gate fails, do NOT merge — fix the failing gate first. Merging a non-green PR is a commitment integrity violation.

## Verification Procedure (Mandatory)

**WARNING: `gh pr checks` is NOT sufficient for 6-green verification.** The Green Gate workflow always exits 0 (success), so `gh pr checks` shows "Green Gate: pass" even when individual gates FAIL. The "CodeRabbit: pass" line means the webhook responded, NOT that CodeRabbit gave an APPROVED review.

### Step-by-step verification

Given a PR number `N` and its branch name `BRANCH`:

```bash
# 1. Get branch name
BRANCH=$(gh pr view N --repo OWNER/REPO --json headRefName --jq '.headRefName')

# 2. Get latest Green Gate run ID (use workflow file name to avoid ambiguity)
RUN_ID=$(gh run list --workflow green-gate.yml --repo OWNER/REPO --branch "$BRANCH" -L 1 --json databaseId --jq '.[0].databaseId')

# 3. Read gate-by-gate results (THE ONLY RELIABLE CHECK)
gh run view "$RUN_ID" --repo OWNER/REPO --log 2>/dev/null | grep -E "GATE-[1-5] (PASS|FAIL)"

# 4. Cross-reference CR review state (do NOT trust gh pr checks)
gh pr view N --repo OWNER/REPO --json reviews --jq '[.reviews[] | select(.state != "COMMENTED") | {author: .author.login, state: .state}] | last'
```

### What each gate checks

| Gate | `gh pr checks` shows | Actually verifies |
|------|---------------------|-------------------|
| 1 | CI check statuses | `commits/{sha}/status` API = "success" |
| 2 | (not shown) | `pulls/{N}` API `.mergeable` = true |
| 3 | "CodeRabbit: pass" (MISLEADING) | Latest non-COMMENTED coderabbitai review = APPROVED |
| 4 | "Cursor Bugbot: pass" (MISLEADING) | cursor[bot] check conclusion = success, no error comments |
| 5 | (not shown) | GraphQL: zero unresolved review threads |
| 6 | (not shown) | Evidence review bot APPROVED |

**Rule**: A PR is 6-green ONLY when all 6 gates show PASS in the workflow logs. Never report 6-green status based on `gh pr checks` output alone.

## PR status check — canonical pattern (mandatory)

**Every PR status check (loops, hooks, one-off) MUST check merge/close state FIRST:**

```bash
# STEP 0 — always first. If merged/closed, stop checking green conditions.
gh api repos/OWNER/REPO/pulls/N --jq '{state, merged}'
# If merged:true or state:"closed" → report and exit. Do NOT check mergeable_state, reviews, etc.
```

Why: `mergeable_state` returns `unknown` for merged PRs (identical to its transient CI-running state). Checking only these fields causes loops to report "blocked" on already-merged PRs for hours.

## PR Freeze Discipline

**Pre-push commit count check**: Before pushing a PR branch, run COMMITS=$(git rev-list --count origin/main..HEAD). If > 5 commits, warn: "N commits — squash before final review to avoid CR incremental stall and merge conflicts."

**Squash before final merge**: When all 6-green conditions are met (or CR has verbally approved in comments), squash all commits into ONE before pushing:

```bash
git reset --soft origin/main
git commit -m "feat(scope): concise single-commit message"
git push --force-with-lease
```

Then merge with explicit human approval (`gh pr merge N --squash --admin`) — this repo no longer has an automated skeptic-cron merge path (retired PR #773); `MERGE APPROVED` from the human is required every time, not just when CR is in incremental stall.

**Why**: 16-commit PR #412 took 5 review rounds. CR treats squashed commits as "already reviewed" and refuses re-review. 1-commit squash merged in one shot.

**Never use `git commit --no-edit`** after a merge conflict — it steals origin/main's commit message. Always provide an explicit squash commit message.

**Admin merge** (when CR is in incremental stall): `gh pr merge N --squash --admin --subject "feat(scope): message"`. Verify `gh api repo --jq .permissions.admin` first.

**Export PR admin merge**: For `jleechanorg/claude-commands` export PRs (title contains "Export"), when `cr-loop-guard.sh` returns `skip` AND CR state is `CHANGES_REQUESTED` on acknowledged design limitations (not code bugs), treat the PR as merge-ready.
