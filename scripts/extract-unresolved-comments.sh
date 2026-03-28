#!/usr/bin/env bash
# =============================================================================
# Deterministic unresolved-comment extraction script
# Usage: scripts/extract-unresolved-comments.sh <owner/repo> <pr_number>
# Output: JSON to stdout — prioritizes Major/Critical CR comments
# =============================================================================
set -euo pipefail

OWNER_REPO="${1:?Usage: $0 <owner/repo> <pr_number>}"
PR_NUM="${2:?Usage: $0 <owner/repo> <pr_number>}"

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
  -F pr="$PR_NUM" \
  2>/dev/null) || RAW=""

# Parse threads — extract unresolved, non-bot, Major/Critical
jq -n \
  --argjson raw "$RAW" \
  --arg owner "$OWNER" \
  --arg repo "$REPO" \
  --arg pr "$PR_NUM" \
'
def BOT_AUTHORS: [
  "coderabbitai", "coderabbitai[bot]", "copilot", "Copilot",
  "cursor[bot]", "cursor", "chatgpt-codex-connector[bot]",
  "github-actions[bot]", "codecov[bot]", "dependabot[bot]"
];

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
    # Preserve thread-level path/line before extracting comment
    map({path, line, comment: (.comments.nodes[0] // null)}) |
    map(select(.comment != null)) |
    map(select((.comment.author.login // "") | IN(BOT_AUTHORS[]) | not)) |
    map({
      path: .path,
      line: .line,
      body: .comment.body,
      body_short: (.comment.body[0:120] + if (.comment.body | length > 120) then "..." else "" end),
      severity: (.comment.body | severity),
      actionable: (.comment.body | actionable),
      priority: (.comment.body | priority),
      author: .comment.author.login,
      created_at: .comment.createdAt
    }) |
    sort_by(.priority) |
    # Compute summary from the sorted list
    (reduce .[] as $t
      ({total:0, critical:0, major:0, medium:0, minor:0, actionable_count:0, by_file:{}};
       .total += 1 |
       (if $t.severity == "Critical" then .critical += 1
        elif $t.severity == "Major" then .major += 1
        elif $t.severity == "Medium" then .medium += 1
        elif $t.severity == "Minor" then .minor += 1
        else . end) |
       (if $t.actionable then .actionable_count += 1 else . end) |
       .by_file[$t.path] = (.by_file[$t.path] // 0) + 1
      ) | {total, critical, major, medium, minor, actionable_count,
           by_file: ([.by_file | to_entries | sort_by(.key) | map({file: .key, count: .value})])}
    ) as $summary |
    {threads: (map({path, line, body, body_short, severity, actionable, priority, author, created_at})), summary}
}
'
