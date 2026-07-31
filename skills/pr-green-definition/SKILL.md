---
name: pr-green-definition
description: Use when checking whether a pull request in this repository is green or before any merge action
type: policy
---

# PR "Green" Definition

`/green` has exactly two gates, evaluated at one current pull-request HEAD:

1. **CI green** — every required CI check at `headRefOid` is terminal and
   successful. For `CheckRun` rows inspect `status` and `conclusion`; for
   `StatusContext` rows inspect `state`.
2. **No merge conflicts** — GitHub reports `mergeable == MERGEABLE`. Retry while
   it is `UNKNOWN`; `CONFLICTING` fails.

Re-read `headRefOid` after both gates. If it changed, the verdict is stale and
both gates must be checked again.

## Verification

Check merge/close state first:

```bash
gh api repos/OWNER/REPO/pulls/N --jq '{state, merged, head: .head.sha}'
```

If the PR is merged or closed, stop. Otherwise inspect the current-head rollup:

```bash
gh pr view N --repo OWNER/REPO \
  --json headRefOid,mergeable,statusCheckRollup \
  --jq '{
    headRefOid,
    mergeable,
    checks: [
      (.statusCheckRollup // [])[] |
      if .__typename == "CheckRun"
      then {type: .__typename, name, status, conclusion}
      else {type: .__typename, context, state}
      end
    ]
  }'
```

Do not infer aggregate CI from one named workflow or from a bot comment. Inspect
every required current-head row using its GraphQL type-specific fields.

## Draft quality and advisory review

Before marking a draft ready, complete the repository's evidence and review
workflows. Resolve actionable comments and triage CodeRabbit, Bugbot, and
Skeptic feedback. Those are quality inputs, not additional `/green` gates and
their approval is not required for a green verdict.

## Merge authorization

A green PR is eligible for a merge decision; it is not merge authorization.
Agents must not merge unless the human's current message contains
`MERGE APPROVED`. Verify both gates again immediately before any authorized
merge.
