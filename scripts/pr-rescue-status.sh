#!/usr/bin/env bash
# =============================================================================
# pr-rescue-status.sh — Deterministic PR readiness for agents (7-green preflight)
#
# Root cause addressed: "stale" workers looping on merged PRs, unresolved threads
# left after fixes, or mergeability UNKNOWN while agents declare progress.
#
# Usage: scripts/pr-rescue-status.sh <owner/repo> <pr_number>
#
# Exit codes:
#   0  PR is MERGED (stop — nothing to rescue), OR open PR passes structural gates
#   1  Blocked — stderr explains next action
#   2  Usage error
#
# Open PR structural gates:
#   - mergeable == MERGEABLE
#   - unresolved GraphQL review threads == 0
#   - reviewDecision == APPROVED
#   - statusCheckRollup: no FAILURE; no IN_PROGRESS/PENDING/QUEUED/WAITING
#   - at least one check in rollup (guards brand-new PRs with no CI yet)
#
# Requires: gh (authenticated), jq
# GraphQL: uses pull_requests_threads feature header (same as extract-unresolved-comments.sh)
# =============================================================================
set -euo pipefail

OWNER_REPO="${1:?Usage: $0 <owner/repo> <pr_number>}"
PR_NUM="${2:?Usage: $0 <owner/repo> <pr_number>}"

OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO#*/}"

die() { echo "$*" >&2; exit 1; }

META=$(gh pr view "$PR_NUM" --repo "$OWNER_REPO" --json state,mergedAt,mergeable,reviewDecision,statusCheckRollup,url,title 2>&1) || {
  die "BLOCKED: gh pr view failed — check auth, repo, and PR number. Output: $META"
}

STATE=$(echo "$META" | jq -r '.state')

if [ "$STATE" = "MERGED" ]; then
  echo "OK: PR #$PR_NUM is MERGED — stop worker rescue; branch work is complete."
  echo "$META" | jq '{url, title}'
  exit 0
fi

if [ "$STATE" = "CLOSED" ]; then
  die "BLOCKED: PR #$PR_NUM is CLOSED (not merged). Reopen or open a new PR."
fi

MERGEABLE=$(echo "$META" | jq -r '.mergeable // "null"')
case "$MERGEABLE" in
  CONFLICTING|false)
    die "BLOCKED: merge conflicts — git fetch origin && git rebase origin/main && resolve && git push --force-with-lease" ;;
  UNKNOWN|null|"")
    die "BLOCKED: mergeability UNKNOWN — GitHub stale. Re-drive: git fetch origin && git rebase origin/main && git push --force-with-lease; recheck gh pr view --json mergeable. Or: gh api repos/$OWNER/$REPO/pulls/$PR_NUM/update --method POST" ;;
esac

ROLLUP_LEN=$(echo "$META" | jq '.statusCheckRollup | length')
if [ "${ROLLUP_LEN:-0}" -eq 0 ]; then
  die "BLOCKED: no status checks in rollup yet — wait for CI to start; do not declare green."
fi

FAILURES=$(echo "$META" | jq '[.statusCheckRollup[]? | select(.conclusion=="FAILURE")] | length')
if [ "${FAILURES:-0}" -gt 0 ]; then
  echo "$META" | jq '[.statusCheckRollup[]? | select(.conclusion=="FAILURE")] | .[0:8]' >&2
  die "BLOCKED: $FAILURES failing check(s) — fix and push."
fi

PENDING=$(echo "$META" | jq '[.statusCheckRollup[]? | select(.status=="IN_PROGRESS" or .status=="PENDING" or .status=="QUEUED" or .status=="WAITING")] | length')
if [ "${PENDING:-0}" -gt 0 ]; then
  die "BLOCKED: $PENDING check(s) still running — exit; let orchestrator poll or wait and re-run this script."
fi

THREAD_QUERY='
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{ isResolved path }
      }
    }
  }
}'
GQL_OUT=$(gh api graphql --header "GraphQL-Features: pull_requests_threads" \
  -f query="$THREAD_QUERY" \
  -f owner="$OWNER" \
  -f name="$REPO" \
  -F number="$PR_NUM" 2>&1) || GQL_OUT=""

if ! echo "$GQL_OUT" | jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1; then
  die "BLOCKED: GraphQL reviewThreads query failed (rate limit or API). Check: gh api rate_limit. Fallback: scripts/extract-unresolved-comments.sh $OWNER_REPO $PR_NUM"
fi

UNRESOLVED=$(echo "$GQL_OUT" | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length')
if [ "${UNRESOLVED:-999}" -gt 0 ]; then
  die "BLOCKED: $UNRESOLVED unresolved review thread(s). Address or resolve threads (GraphQL resolveReviewThread if code already fixed); document in PR body Resolved Comments table (bd-ara.1); post @coderabbitai all good?"
fi

RD=$(echo "$META" | jq -r '.reviewDecision // "EMPTY"')
if [ "$RD" != "APPROVED" ]; then
  die "BLOCKED: reviewDecision=$RD (need APPROVED). Fix feedback; after push, CodeRabbit is pinged automatically (coderabbit-ping-on-push.yml) or comment @coderabbitai all good?"
fi

SKEPTIC_FAIL=$(echo "$META" | jq '[.statusCheckRollup[]? | select((.name=="Skeptic Gate" or .name=="skeptic_gate") and .conclusion=="FAILURE")] | length')
if [ "${SKEPTIC_FAIL:-0}" -gt 0 ]; then
  die "BLOCKED: Skeptic Gate FAILURE — follow CLAUDE.md Skeptic chain (local ao skeptic verify / lifecycle-worker)."
fi

echo "OK: PR #$PR_NUM passes structural preflight (7-green mechanical checks)."
echo "$META" | jq '{url, title, mergeable, reviewDecision, skeptic: [.statusCheckRollup[]? | select(.name=="Skeptic Gate" or .name=="skeptic_gate") | {name, conclusion}]}'
exit 0
