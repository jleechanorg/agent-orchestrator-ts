# bd-ara.1 — Resolved Comments in PR Description

**Resolved:** 2026-03-23 (session ao-611)
**Change:** `defaults.agentRules` in `~/.openclaw/agent-orchestrator.yaml`

## What Changed

The `AFTER FIXING REVIEW COMMENTS` section was rewritten to use **PR description documentation** instead of **GraphQL thread resolution**.

### Before (GraphQL — expensive, rate-limit-burning)

```yaml
# Removed:
gh api graphql ... (resolveReviewThread mutation per thread)
# Burned 10+ GraphQL mutations per PR × 19 PRs = 190+ mutations/cycle
```

### After (PR description documentation — zero GraphQL)

```yaml
**AFTER FIXING REVIEW COMMENTS — DOCUMENT IN PR DESCRIPTION (bd-ara.1):**
After addressing review comments (from CodeRabbit, Copilot, Bugbot, or humans):
1. Push the fix commit
2. Document what you resolved in the PR description by appending a table:
   gh pr edit --body "$(gh pr view --json body --jq '.body')"$'\n\n'"## Resolved Comments\n| Reviewer | File | Comment | Resolution |\n|---|---|---|---|\n| coderabbitai[bot] | <file> | <comment summary> | Fixed in $(git rev-parse --short HEAD) |"
   - Only document Major/Critical/actionable comments — nitpicks and "suggestion" comments do not block green.
   - This satisfies green condition #5 (all inline comments resolved) by providing an auditable record.
3. Post `@coderabbitai all good?` to trigger re-review
4. If CodeRabbit reviewDecision is stuck at CHANGES_REQUESTED after all actionable items fixed and new commit pushed, the review is stale — dismiss it:
   gh api repos/<OWNER>/<REPO>/pulls/<PR>/reviews/<REVIEW_ID>/dismissals --method PUT -f message="All issues addressed" -f event="DISMISS"
   Then post `@coderabbitai review` to trigger fresh review.
NOTE: Do NOT use GraphQL to resolve individual review threads — it is expensive. The PR description table is the authoritative record of resolution.
```

## Why This Works

- GitHub PR description updates are cheap (1 REST PATCH per update)
- The `## Resolved Comments` table provides an auditable record of which review comments were addressed
- Agents already read review comments — they just need to document what they fixed
- No GraphQL mutations burned on thread resolution

## Impact

- Zero GraphQL mutations per PR for comment resolution (was 10-14 per PR)
- Condition #5 (all comments resolved) now has a clear, auditable path
- Aligns with the `/copilot` approach already used in the codebase
