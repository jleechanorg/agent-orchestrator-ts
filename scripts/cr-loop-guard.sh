#!/usr/bin/env bash
# =============================================================================
# Anti-loop guard: detect repeated CodeRabbit CHANGES_REQUESTED patterns
# Prevents workers from spamming @coderabbitai all good? without SHA progress
# Usage: scripts/cr-loop-guard.sh <owner/repo> <pr_number> [--fix-mode]
# Output: JSON with loop_detected, actionable_set_hash, sha_progress fields
# If --fix-mode: prints the action to take (copilot-expanded | cr-trigger | skip)
# =============================================================================
set -euo pipefail

OWNER_REPO="${1:?Usage: $0 <owner/repo> <pr_number> [--fix-mode]}"
PR_NUM="${2:?Usage: $0 <owner/repo> <pr_number> [--fix-mode]}"
MODE="${3:-query}"   # query | fix-mode

OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO#*/}"

# NOTE: In GitHub Actions (cr-loop-health.yml), the runner filesystem is ephemeral.
# The cache file will not persist across workflow runs. This is acceptable for
# manual workflow_dispatch use; cross-run loop detection requires the GitHub cache API.
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ao-cr-loop-guard"
CACHE_FILE="$CACHE_DIR/${OWNER}_${REPO}_${PR_NUM}.json"
MAX_LOOPS=2   # Allow 2 cycles of same actionable set before forcing copilot-expanded

mkdir -p "$CACHE_DIR"

# Step 1: Get current unresolved CR comments from GraphQL
GRAPHQL_QUERY='
query CRComments($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          path
          line
          comments(first: 1) {
            nodes {
              author { login }
              body
              createdAt
            }
          }
        }
      }
    }
  }
}'

RAW=$(gh api graphql \
  --header "GraphQL-Features: pull_requests_threads" \
  -f query="$GRAPHQL_QUERY" \
  -f owner="$OWNER" \
  -f repo="$REPO" \
  -F pr="$PR_NUM" \
  2>/dev/null) || RAW=""

# Step 2: Extract actionable comment fingerprints (path+line+first 80 non-whitespace chars)
ACTIONABLE_HASH=$(echo "$RAW" | jq -r '
  [.data.repository.pullRequest.reviewThreads.nodes[] |
   select(.isResolved == false) |
   select(.comments.nodes[0].author.login == "coderabbitai") |
   .comments.nodes[0].body // "" |
   .[:80] | gsub("[ \n\r\t]+"; ""))] |
  sort | join("|")' 2>/dev/null || echo "PARSE_ERROR")

ACTIONABLE_COUNT=$(echo "$RAW" | jq -r '
  [.data.repository.pullRequest.reviewThreads.nodes[] |
   select(.isResolved == false) |
   select(.comments.nodes[0].author.login == "coderabbitai")] |
  length' 2>/dev/null || echo "0")

# Step 3: Get current HEAD SHA
HEAD_SHA=$(gh api repos/"$OWNER"/"$REPO"/pulls/"$PR_NUM" --jq '.head.sha' 2>/dev/null || echo "unknown")

# Step 4: Load previous state
PREV_SHA="${PREV_SHA:-}"
PREV_HASH="${PREV_HASH:-}"
PREV_COUNT="${PREV_COUNT:-0}"
PREV_LOOPS="${PREV_LOOPS:-0}"

if [ -f "$CACHE_FILE" ]; then
  PREV_SHA=$(jq -r '.prev_sha // ""' "$CACHE_FILE" 2>/dev/null || echo "")
  PREV_HASH=$(jq -r '.actionable_hash // ""' "$CACHE_FILE" 2>/dev/null || echo "")
  PREV_COUNT=$(jq -r '.actionable_count // 0' "$CACHE_FILE" 2>/dev/null || echo "0")
  PREV_LOOPS=$(jq -r '.loop_count // 0' "$CACHE_FILE" 2>/dev/null || echo "0")
fi

# Step 5: Determine loop state
SHA_CHANGED="true"
if [ "$PREV_SHA" = "$HEAD_SHA" ] || [ -z "$PREV_SHA" ]; then
  SHA_CHANGED="false"
fi

# Loop detection: only increment when both SHA unchanged AND actionable set unchanged
# (neither new code pushed nor any comments resolved → stall)
# Reset in all other cases: new commit, or CR made progress (new comments posted/resolved)
if [ "$SHA_CHANGED" = "false" ] && \
   [ "$ACTIONABLE_HASH" = "$PREV_HASH" ] && \
   [ -n "$PREV_HASH" ]; then
  LOOP_COUNT=$((PREV_LOOPS + 1))
else
  LOOP_COUNT=0
fi

# Step 6: Write cache
jq -n \
  --arg sha "$HEAD_SHA" \
  --arg hash "$ACTIONABLE_HASH" \
  --argjson count "$ACTIONABLE_COUNT" \
  --argjson loops "$LOOP_COUNT" \
  '{
    prev_sha: $sha,
    actionable_hash: $hash,
    actionable_count: $count,
    loop_count: $loops,
    updated_at: now | todateiso8601
  }' > "$CACHE_FILE"

# Step 7: Determine recommended action
if [ "$MODE" = "fix-mode" ]; then
  if [ "$LOOP_COUNT" -ge "$MAX_LOOPS" ]; then
    echo "copilot-expanded"
  elif [ "$SHA_CHANGED" = "true" ]; then
    echo "cr-trigger"
  else
    echo "skip  # no SHA progress, loop_count=$LOOP_COUNT"
  fi
else
  jq -n \
    --arg sha "$HEAD_SHA" \
    --argjson count "$ACTIONABLE_COUNT" \
    --argjson loops "$LOOP_COUNT" \
    --argjson max "$MAX_LOOPS" \
    --arg sha_changed "$SHA_CHANGED" \
    --argjson same_hash "$([[ "$ACTIONABLE_HASH" = "$PREV_HASH" ]] && echo true || echo false)" \
    '{
      loop_detected: ($loops >= $max),
      actionable_count: $count,
      loop_count: $loops,
      loop_limit: $max,
      sha_progress: $sha_changed,
      same_actionable_set: $same_hash,
      recommendation: (
        if $loops >= $max then "copilot-expanded"
        elif $sha_changed then "cr-trigger"
        else "skip"
        end
      )
    }'
fi
