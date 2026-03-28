#!/usr/bin/env bash
# scripts/check-pr-worker-coverage.sh
# Validates PR→session coverage for jleechanorg/agent-orchestrator.
# Exits 0 if all open PRs have an active session; exits non-zero if uncovered PRs remain.
#
# bd-ara.stale additions:
# - Fetches createdAt for every open PR and displays age in hours
# - Flags >3h PRs as STALE (stale-threshold configurable via STALE_HOURS env var)
# - Guardrail: exits non-zero if createdAt field is missing from any PR

set -euo pipefail

REPO="jleechanorg/agent-orchestrator"
PROJECT="agent-orchestrator"
STALE_HOURS="${STALE_HOURS:-3}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_pr_age_hours() {
  local created_at="$1"
  if [[ -z "$created_at" || "$created_at" == "null" ]]; then
    echo "-1"
    return
  fi
  python3 -c "
import sys, datetime
try:
    created = datetime.datetime.fromisoformat('$created_at'.replace('Z','+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(f'{(now - created).total_seconds() / 3600.0:.1f}')
except Exception:
    print('-1')
" 2>/dev/null || echo "-1"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

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

# Fetch open PRs with createdAt for age tracking
echo "=== Open PRs ==="
pr_data=$(gh pr list --repo "$REPO" --state open --limit 100 \
  --json number,title,headRefName,createdAt 2>/dev/null)
if [[ -z "$pr_data" ]]; then
  echo "ERROR: Failed to fetch open PRs from $REPO" >&2
  exit 1
fi

declare -a uncovered=()
missing_age=0
stale_uncovered=0
age_hours=""
age_str=""
is_stale=0
coverage_status=""

while IFS= read -r pr_line; do
  pr_number=$(echo "$pr_line" | jq -r '.number')
  pr_branch=$(echo "$pr_line" | jq -r '.headRefName')
  pr_title=$(echo "$pr_line" | jq -r '.title')
  pr_created=$(echo "$pr_line" | jq -r '.createdAt')

  # Guardrail: fail if createdAt is missing (bd-ara.stale mechanical check)
  age_hours=$(_pr_age_hours "$pr_created")
  if [[ "$age_hours" == "-1" || -z "$pr_created" || "$pr_created" == "null" ]]; then
    echo "  PR #$pr_number [$pr_branch]: $pr_title"
    echo "    -> AGE_FIELD_MISSING (guardrail failure)"
    missing_age=$((missing_age + 1))
    continue
  fi

  age_str="${age_hours}h"
  is_stale=0
  if python3 -c "import sys; sys.exit(0 if float('$age_hours') >= float('$STALE_HOURS') else 1)" 2>/dev/null; then
    is_stale=1
  fi

  # Check if any active session is working on this branch
  coverage_status=""
  if [[ -v session_map["$pr_branch"] ]]; then
    coverage_status="covered by session ${session_map[$pr_branch]}"
  else
    if [[ "$is_stale" == "1" ]]; then
      echo "  PR #$pr_number [$pr_branch]: age=${age_str} [STALE] [UNCOVERED] ***"
      echo "    -> no active session; age exceeds ${STALE_HOURS}h threshold"
      uncovered+=("PR #$pr_number [STALE age=${age_str}]")
      stale_uncovered=$((stale_uncovered + 1))
      continue
    else
      echo "  PR #$pr_number [$pr_branch]: age=${age_str}"
      echo "    -> UNCOVERED (no active session)"
      uncovered+=("PR #$pr_number [age=${age_str}]")
      continue
    fi
  fi

  echo "  PR #$pr_number [$pr_branch]: age=${age_str}"
  echo "    -> $coverage_status"
done <<< "$(echo "$pr_data" | jq -c '.[]')"

echo
# Guardrail: missing createdAt is always a hard failure
if [[ "$missing_age" -gt 0 ]]; then
  echo "=== Result: GUARDRAIL FAILURE — $missing_age PR(s) missing createdAt ==="
  echo "Run: ao spawn --project agent-orchestrator --claim-pr <PR_NUMBER>"
  exit 2
fi

if [[ ${#uncovered[@]} -eq 0 ]]; then
  echo "=== Result: ALL OPEN PRs COVERED ==="
  exit 0
else
  echo "=== Result: ${#uncovered[@]} UNCOVERED PR(s) ($stale_uncovered stale >${STALE_HOURS}h) ==="
  for pr in "${uncovered[@]}"; do
    echo "  $pr"
  done
  echo ""
  echo "Run: ao spawn --project agent-orchestrator --claim-pr <PR_NUMBER>"
  exit 1
fi
