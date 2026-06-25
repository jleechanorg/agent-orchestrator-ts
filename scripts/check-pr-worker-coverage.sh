#!/usr/bin/env bash
# scripts/check-pr-worker-coverage.sh
# Validates PR→session coverage for jleechanorg/agent-orchestrator.
# Exits 0 if all open PRs have an active session; exits non-zero if uncovered PRs remain.
#
# bd-ara.stale additions:
# - Fetches createdAt for every open PR and displays age in hours
# - Flags PRs with age ≥${STALE_HOURS}h as STALE (stale-threshold configurable via STALE_HOURS env var)
# - Guardrail: exits non-zero if createdAt field is missing from any PR

set -euo pipefail

REPO="jleechanorg/agent-orchestrator"
PROJECT="agent-orchestrator"
STALE_HOURS="${STALE_HOURS:-3}"
LIFECYCLE_LOG="${LIFECYCLE_LOG:-$HOME/.hermes/logs/ao-lifecycle-${PROJECT}.log}"
# Guardrail: reject non-numeric values before they can cause false-stale/false-fresh
if ! [[ "$STALE_HOURS" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]]; then
  echo "ERROR: STALE_HOURS must be a positive number (got: '$STALE_HOURS')" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_pr_age_hours() {
  local created_at="$1"
  if [[ -z "$created_at" || "$created_at" == "null" ]]; then
    echo "-1"
    return
  fi
  # Pass value via argv to avoid shell-variable injection into Python source
  python3 - "$created_at" 2>/dev/null <<'PY' || echo "-1"
import sys, datetime
try:
    created = datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(f'{(now - created).total_seconds() / 3600.0:.1f}')
except Exception:
    print('-1')
PY
}

_latest_claim_failure_for_pr() {
  local pr_number="$1"
  python3 - "$LIFECYCLE_LOG" "$pr_number" 2>/dev/null <<'PY' || true
import json
import pathlib
import sys

log_path = pathlib.Path(sys.argv[1])
target_pr = int(sys.argv[2])
latest = ""

if not log_path.exists():
    raise SystemExit(0)

for raw in log_path.read_text(errors="ignore").splitlines():
    if "lifecycle.backfill.claim_failed" not in raw:
        continue
    try:
        payload = json.loads(raw)
    except Exception:
        continue
    if payload.get("operation") != "lifecycle.backfill.claim_failed":
        continue
    data = payload.get("data") or {}
    if data.get("prNumber") != target_pr:
        continue
    err = " ".join(str(data.get("error", "")).split())
    latest = err

if latest:
    if len(latest) > 220:
        latest = latest[:217] + "..."
    print(latest)
PY
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

# Also extract session→PR mappings when `ao session ls` includes a GitHub API URL.
# Current output typically uses `.../pulls/<num>`.
declare -A session_pr_map  # key=PR number, value=session id
while IFS= read -r line; do
  if [[ $line =~ ^[[:space:]]+([a-z]+-[0-9]+).*/pulls/([0-9]+)([[:space:]]|$) ]]; then
    sid="${BASH_REMATCH[1]}"
    pr_number="${BASH_REMATCH[2]}"
    session_pr_map["$pr_number"]="$sid"
  fi
done <<< "$session_output"

echo "=== Active Sessions ==="
if [[ "${session_map[@]+x}" != "x" ]] || [[ ${#session_map[@]} -eq 0 ]]; then
  echo "(none)"
else
  for branch in "${!session_map[@]}"; do
    echo "  ${session_map[$branch]} -> $branch"
  done
fi
echo

# Fetch open PRs with createdAt for age tracking
# Use REST API to avoid GraphQL rate limit exhaustion
echo "=== Open PRs ==="
# Disable errexit for the gh call — command substitution swallows the exit code
# but the gh command itself can fail under set -e before assignment completes.
set +e
pr_data=$(gh api "repos/$REPO/pulls?state=open&per_page=100" \
  --jq '[.[] | {number: .number, title: .title, headRefName: .head.ref, createdAt: .created_at}]' 2>/dev/null)
_fetch_rc=$?
set -e
if [[ "$_fetch_rc" -ne 0 ]] || [[ -z "$pr_data" ]]; then
  echo "ERROR: Failed to fetch open PRs from $REPO (rc=$_fetch_rc)" >&2
  exit 1
fi
# Validate pr_data is a JSON array (not a malformed payload)
if ! echo "$pr_data" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: Invalid PR list payload from $REPO (not a JSON array)" >&2
  exit 1
fi
# Empty array is OK — no open PRs is a valid state

declare -a uncovered=()
missing_age=0
stale_uncovered=0
age_hours=""
age_str=""
is_stale=0
coverage_status=""
claim_failure=""

while IFS= read -r pr_line || [[ -n "$pr_line" ]]; do
  [[ -z "$pr_line" ]] && continue
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
  # Use pure bash comparison to avoid python3 -c injection risks with shell variables
  if python3 - "$age_hours" "$STALE_HOURS" 2>/dev/null <<'PY'; then
import sys
try:
    sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)
except:
    sys.exit(1)
PY
    is_stale=1
  fi

  # Check if any active session is working on this branch
  coverage_status=""
  claim_failure=""
  if [[ -v session_map["$pr_branch"] ]]; then
    coverage_status="covered by session ${session_map[$pr_branch]}"
  elif [[ -v session_pr_map["$pr_number"] ]]; then
    coverage_status="covered by session ${session_pr_map[$pr_number]}"
  else
    claim_failure="$(_latest_claim_failure_for_pr "$pr_number")"
    if [[ "$is_stale" == "1" ]]; then
      echo "  PR #$pr_number [$pr_branch]: age=${age_str} [STALE] [UNCOVERED] ***"
      if [[ -n "$claim_failure" ]]; then
        echo "    -> BLOCKED recent claim_failed: $claim_failure"
        uncovered+=("PR #$pr_number [BLOCKED STALE age=${age_str}]")
      else
        echo "    -> no active session; age ≥${STALE_HOURS}h threshold"
        uncovered+=("PR #$pr_number [STALE age=${age_str}]")
      fi
      stale_uncovered=$((stale_uncovered + 1))
      continue
    else
      echo "  PR #$pr_number [$pr_branch]: age=${age_str}"
      if [[ -n "$claim_failure" ]]; then
        echo "    -> BLOCKED recent claim_failed: $claim_failure"
        uncovered+=("PR #$pr_number [BLOCKED age=${age_str}]")
      else
        echo "    -> UNCOVERED (no active session)"
        uncovered+=("PR #$pr_number [age=${age_str}]")
      fi
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
