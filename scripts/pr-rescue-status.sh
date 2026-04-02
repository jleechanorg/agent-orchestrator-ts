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
#   2  Usage error (wrong/missing arguments)
#
# Open PR structural gates:
#   - mergeable == MERGEABLE
#   - unresolved GraphQL review threads == 0 (paginated)
#   - reviewDecision == APPROVED
#   - statusCheckRollup: no blocking terminal conclusion (see BLOCKING below)
#   - no IN_PROGRESS/PENDING/QUEUED/WAITING
#   - at least one check in rollup (guards brand-new PRs with no CI yet)
#
# Blocking conclusions (GitHub CheckRun): FAILURE, TIMED_OUT, ERROR, CANCELLED,
#   ACTION_REQUIRED, STALE, STARTUP_FAILURE (not exhaustive — matches skeptic-adjacent gates)
#
# Requires: gh (authenticated), jq
# GraphQL: uses pull_requests_threads feature header (same as extract-unresolved-comments.sh)
# =============================================================================
set -euo pipefail

usage() {
  echo "Usage: $0 <owner/repo> <pr_number>" >&2
}

if [ "$#" -lt 2 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  usage
  exit 2
fi

OWNER_REPO="$1"
PR_NUM="$2"

OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO#*/}"

die() { echo "$*" >&2; exit 1; }

# jq: count rollup entries whose conclusion is a blocking terminal state
BLOCKING_CONCLUSIONS_JSON='["FAILURE","TIMED_OUT","ERROR","CANCELLED","ACTION_REQUIRED","STALE","STARTUP_FAILURE"]'

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
    die "BLOCKED: mergeability UNKNOWN — GitHub stale. Re-drive: git fetch origin && git rebase origin/main && git push --force-with-lease; recheck gh pr view --json mergeable. Or: gh pr update-branch \"$PR_NUM\" --repo \"$OWNER_REPO\"" ;;
esac

# statusCheckRollup may contain multiple rows per check name (stale runs). Evaluate only
# the latest completedAt per name — matches what humans see as "current" check state.
ROLLUP_LATEST=$(echo "$META" | jq '[.statusCheckRollup[]? | select(.name != null and .name != "")] | group_by(.name) | map(sort_by(.completedAt) | last)')

ROLLUP_LEN=$(echo "$ROLLUP_LATEST" | jq 'length')
if [ "${ROLLUP_LEN:-0}" -eq 0 ]; then
  die "BLOCKED: no status checks in rollup yet — wait for CI to start; do not declare green."
fi

PENDING=$(echo "$ROLLUP_LATEST" | jq '[.[] | select(.status=="IN_PROGRESS" or .status=="PENDING" or .status=="QUEUED" or .status=="WAITING")] | length')
if [ "${PENDING:-0}" -gt 0 ]; then
  die "BLOCKED: $PENDING check(s) still running — exit; let orchestrator poll or wait and re-run this script."
fi

# Skeptic-specific failure (latest Skeptic-named check only) — before generic blocking list
LAST_SKEPTIC_CONC=$(echo "$ROLLUP_LATEST" | jq -r '[.[] | select(.name=="Skeptic Gate" or .name=="skeptic_gate")] | sort_by(.completedAt) | last | .conclusion // empty')
if [ -n "$LAST_SKEPTIC_CONC" ] && [ "$LAST_SKEPTIC_CONC" != "null" ]; then
  IS_SKEPTIC_BLOCK=$(echo "$BLOCKING_CONCLUSIONS_JSON" | jq --arg c "$LAST_SKEPTIC_CONC" 'index($c) != null')
  if [ "$IS_SKEPTIC_BLOCK" = "true" ]; then
    die "BLOCKED: Skeptic Gate terminal failure (latest run) — follow CLAUDE.md Skeptic chain (local ao skeptic verify / lifecycle-worker)."
  fi
fi

FAILURES=$(echo "$ROLLUP_LATEST" | jq --argjson bc "$BLOCKING_CONCLUSIONS_JSON" \
  '[.[] | select(.conclusion as $c | $c != null and ($bc | index($c) != null))] | length')
if [ "${FAILURES:-0}" -gt 0 ]; then
  echo "$ROLLUP_LATEST" | jq --argjson bc "$BLOCKING_CONCLUSIONS_JSON" \
    '[.[] | select(.conclusion as $c | $c != null and ($bc | index($c) != null))] | .[0:8]' >&2
  die "BLOCKED: $FAILURES failing check(s) — fix and push."
fi

# Paginated unresolved thread count (reviewThreads first:100 per page)
UNRESOLVED=0
CURSOR=""
PAGE=0
while true; do
  PAGE=$((PAGE + 1))
  if [ "$PAGE" -gt 50 ]; then
    die "BLOCKED: review thread pagination exceeded 50 pages — escalate (unexpected PR size)."
  fi
  if [ -z "$CURSOR" ]; then
    GQL_OUT=$(gh api graphql --header "GraphQL-Features: pull_requests_threads" \
      -f query='query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            reviewThreads(first:100){
              pageInfo{hasNextPage endCursor}
              nodes{isResolved}
            }
          }
        }
      }' \
      -f owner="$OWNER" \
      -f name="$REPO" \
      -F number="$PR_NUM" 2>&1) || GQL_OUT=""
  else
    GQL_OUT=$(gh api graphql --header "GraphQL-Features: pull_requests_threads" \
      -f query='query($owner:String!,$name:String!,$number:Int!,$cursor:String!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            reviewThreads(first:100, after:$cursor){
              pageInfo{hasNextPage endCursor}
              nodes{isResolved}
            }
          }
        }
      }' \
      -f owner="$OWNER" \
      -f name="$REPO" \
      -F number="$PR_NUM" \
      -f cursor="$CURSOR" 2>&1) || GQL_OUT=""
  fi

  if ! echo "$GQL_OUT" | jq -e '.data.repository.pullRequest.reviewThreads' >/dev/null 2>&1; then
    die "BLOCKED: GraphQL reviewThreads query failed (rate limit or API). Check: gh api rate_limit. Fallback: scripts/extract-unresolved-comments.sh $OWNER_REPO $PR_NUM"
  fi

  PAGE_UNRES=$(echo "$GQL_OUT" | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length')
  UNRESOLVED=$((UNRESOLVED + PAGE_UNRES))
  HAS_NEXT=$(echo "$GQL_OUT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
  CURSOR=$(echo "$GQL_OUT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty')
  if [ "$HAS_NEXT" != "true" ]; then
    break
  fi
  if [ -z "$CURSOR" ]; then
    die "BLOCKED: GraphQL returned hasNextPage but no endCursor"
  fi
done

if [ "${UNRESOLVED:-999}" -gt 0 ]; then
  die "BLOCKED: $UNRESOLVED unresolved review thread(s). Address or resolve threads (GraphQL resolveReviewThread if code already fixed); document in PR body Resolved Comments table (bd-ara.1); post @coderabbitai all good?"
fi

RD=$(echo "$META" | jq -r '.reviewDecision // "EMPTY"')
if [ "$RD" != "APPROVED" ]; then
  die "BLOCKED: reviewDecision=$RD (need APPROVED). Fix feedback; after push, CodeRabbit is pinged automatically (coderabbit-ping-on-push.yml) or comment @coderabbitai all good?"
fi

echo "OK: PR #$PR_NUM passes structural preflight (7-green mechanical checks)."
echo "$META" | jq '{url, title, mergeable, reviewDecision, skeptic: [.statusCheckRollup[]? | select(.name=="Skeptic Gate" or .name=="skeptic_gate") | {name, conclusion}]}'
exit 0
