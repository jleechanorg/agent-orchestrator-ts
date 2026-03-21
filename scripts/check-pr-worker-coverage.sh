#!/usr/bin/env bash
# scripts/check-pr-worker-coverage.sh
# Validates PR→session coverage for jleechanorg/agent-orchestrator.
# Exits 0 if all open PRs have an active session; exits non-zero if uncovered PRs remain.

set -euo pipefail

REPO="jleechanorg/agent-orchestrator"
PROJECT="agent-orchestrator"

# EPIPE guard: capture session list with guard to prevent pipe EPIPE from killing script
session_output=$(ao session ls --project "$PROJECT" 2>/dev/null) || {
  echo "WARNING: ao session ls failed — assuming no active sessions" >&2
  session_output=""
}

# Extract session→branch mappings from output
# Each line format: ao-###  (time)  branch  [state]  [PR_URL]
declare -A session_map  # key=branch name, value=session id
while IFS= read -r line; do
  # Match lines like: ao-406  (19s ago)  feat/pr-worker-coverage-harness  [working]
  if [[ $line =~ ^[[:space:]]+([a-z]+-[0-9]+)[[:space:]]+.*[[:space:]]+([a-zA-Z0-9/_-]+)[[:space:]]+\[.*\] ]]; then
    sid="${BASH_REMATCH[1]}"
    branch="${BASH_REMATCH[2]}"
    session_map["$branch"]="$sid"
  fi
done <<< "$session_output"

echo "=== Active Sessions ==="
if [[ ${#session_map[@]} -eq 0 ]]; then
  echo "(none)"
else
  for branch in "${!session_map[@]}"; do
    echo "  ${session_map[$branch]} -> $branch"
  done
fi
echo

# Fetch open PRs
echo "=== Open PRs ==="
pr_data=$(gh pr list --repo "$REPO" --state open --limit 100 --json number,title,headRefName 2>/dev/null)
if [[ -z "$pr_data" ]]; then
  echo "ERROR: Failed to fetch open PRs from $REPO" >&2
  exit 1
fi

declare -a uncovered=()
while IFS= read -r pr_line; do
  pr_number=$(echo "$pr_line" | jq -r '.number')
  pr_branch=$(echo "$pr_line" | jq -r '.headRefName')
  pr_title=$(echo "$pr_line" | jq -r '.title')
  echo "  PR #$pr_number [$pr_branch]: $pr_title"

  # Check if any active session is working on this branch
  if [[ -v session_map["$pr_branch"] ]]; then
    echo "    -> covered by session ${session_map[$pr_branch]}"
  else
    echo "    -> UNCOVERED (no active session)"
    uncovered+=("PR #$pr_number [$pr_branch]")
  fi
done <<< "$(echo "$pr_data" | jq -c '.[]')"

echo
if [[ ${#uncovered[@]} -eq 0 ]]; then
  echo "=== Result: ALL OPEN PRs COVERED ==="
  exit 0
else
  echo "=== Result: ${#uncovered[@]} UNCOVERED PR(s) ==="
  for pr in "${uncovered[@]}"; do
    echo "  $pr"
  done
  echo ""
  echo "Run: ao spawn --project agent-orchestrator --claim-pr <PR_NUMBER>"
  exit 1
fi
