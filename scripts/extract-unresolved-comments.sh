#!/usr/bin/env bash
# =============================================================================
# Deterministic unresolved-comment extraction script
# Usage: scripts/extract-unresolved-comments.sh <owner/repo> <pr_number>
# Output: JSON to stdout — prioritizes Major/Critical CR comments
# =============================================================================
set -euo pipefail

OWNER_REPO="${1:?Usage: $0 <owner/repo> <pr_number> [GITHUB_TOKEN]}"
PR_NUM="${2:?Usage: $0 <owner/repo> <pr_number> [GITHUB_TOKEN]}"
TOKEN="${3:-${GITHUB_TOKEN:-}}"

OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO#*/}"

GRAPHQL_QUERY='
query UnresolvedComments($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          path
          line
          diffSide
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

# Fetch via GraphQL
RAW=$(gh api graphql \
  --header "GraphQL-Features: pull_requests_threads" \
  -f query="$GRAPHQL_QUERY" \
  -f owner="$OWNER" \
  -f repo="$REPO" \
  -f pr="$PR_NUM" \
  2>/dev/null) || RAW=""

# Parse threads — extract unresolved, non-bot, Major/Critical
jq -n \
  --argjson raw "$RAW" \
  --arg owner "$OWNER" \
  --arg repo "$REPO" \
  --arg pr "$PR_NUM" \
'
def BOT_AUTHORS: {
  "coderabbitai", "coderabbitai[bot]", "copilot", "Copilot",
  "cursor[bot]", "cursor", "chatgpt-codex-connector[bot]",
  "github-actions[bot]", "codecov[bot]", "dependabot[bot]"
};

def severity($body):
  if ($body | test("Critical|🔴"; "i")) then "Critical"
  elif ($body | test("Major|🟠|High"; "i")) then "Major"
  elif ($body | test("Medium|🟡|warning"; "i")) then "Medium"
  elif ($body | test("Minor|🟢|Low|nit"; "i")) then "Minor"
  else "Unknown"
  end;

def actionable($body):
  ($body | test("\\b(fix|bug|issue|change|update|please|should|must|need|broken|error|fail|wrong|missing)\\b"; "i"))
;

def priority($body):
  if ($body | severity == "Critical") then 1
  elif ($body | severity == "Major") then 2
  elif ($body | severity == "Medium") then 3
  elif ($body | actionable) then 4
  else 5
  end;

{
  pr: "\($owner)/\($repo)#\($pr)",
  fetched_at: now | todateiso8601,
  method: "graphql",
  threads: (
    ($raw.data.repository.pullRequest.reviewThreads.nodes // []) |
    map(select(.isResolved == false)) |
    map(.comments.nodes[0] // null) |
    map(select(. != null)) |
    map(select((.author.login // "") | inside(BOT_AUTHORS) | not)) |
    map({
      path: .path,
      line: .line,
      body: .body,
      body_short: (.body[0:120] + if (.body | length > 120) then "..." else "" end),
      severity: (.body | severity),
      actionable: (.body | actionable),
      priority: (.body | priority),
      author: .author.login,
      created_at: .createdAt
    }) |
    sort_by(.priority)
  ),
  summary: {
    total: length,
    critical: map(select(.severity == "Critical")) | length,
    major:    map(select(.severity == "Major")) | length,
    medium:   map(select(.severity == "Medium")) | length,
    minor:    map(select(.severity == "Minor")) | length,
    actionable_count: map(select(.actionable == true)) | length,
    by_file: (map(.path) | group_by(.) | map({file: .[0], count: length}))
  }
}
'
