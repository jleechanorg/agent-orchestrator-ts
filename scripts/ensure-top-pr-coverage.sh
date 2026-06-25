#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-jleechanorg/agent-orchestrator}"
PROJECT="${PROJECT:-agent-orchestrator}"
TOP_N="${TOP_N:-5}"
TMUX_SESSION_BUDGET="${TMUX_SESSION_BUDGET:-20}"
SPAWN_MISSING="${SPAWN_MISSING:-1}"
LIFECYCLE_LOG="${LIFECYCLE_LOG:-$HOME/.hermes/logs/ao-lifecycle-${PROJECT}.log}"

if ! [[ "$TOP_N" =~ ^[0-9]+$ ]] || [ "$TOP_N" -le 0 ]; then
  echo "TOP_N must be a positive integer" >&2
  exit 2
fi
if ! [[ "$TMUX_SESSION_BUDGET" =~ ^[0-9]+$ ]] || [ "$TMUX_SESSION_BUDGET" -lt 0 ]; then
  echo "TMUX_SESSION_BUDGET must be a non-negative integer" >&2
  exit 2
fi

latest_claim_failure_for_pr() {
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
    latest = " ".join(str(data.get("error", "")).split())

if latest:
    if len(latest) > 220:
        latest = latest[:217] + "..."
    print(latest)
PY
}

unset GITHUB_TOKEN

session_output="$(ao session ls --project "$PROJECT" 2>/dev/null || true)"
declare -A session_pr_map
while IFS= read -r line; do
  if [[ $line =~ ^[[:space:]]+([a-z]+-[0-9]+).*/pulls/([0-9]+)([[:space:]]|$) ]]; then
    sid="${BASH_REMATCH[1]}"
    pr_number="${BASH_REMATCH[2]}"
    session_pr_map["$pr_number"]="$sid"
  fi
done <<< "$session_output"

open_prs_json="$(gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '
  [.[] | select(.draft == false) | {number: .number, title: .title, branch: .head.ref, createdAt: .created_at}]
' 2>/dev/null)"
if [[ -z "$open_prs_json" || "$open_prs_json" == "[]" ]]; then
  echo "No open non-draft PRs in $REPO"
  exit 0
fi

review_rows="$(
  python3 - "$open_prs_json" <<'PY'
import json
import sys
prs = json.loads(sys.argv[1])
for pr in prs:
    print(f"{pr['number']}\t{pr['createdAt']}\t{pr['branch']}\t{pr['title']}")
PY
)"

rank_input=""
while IFS=$'\t' read -r pr_number created_at pr_branch pr_title; do
  [[ -z "$pr_number" ]] && continue
  review_state="$(
    gh api "repos/$REPO/pulls/$pr_number/reviews" --jq '
      [.[] | select(.state != "COMMENTED")]
      | group_by(.user.login)
      | map(.[-1].state)
      | if any(. == "CHANGES_REQUESTED") then "CHANGES_REQUESTED"
        elif (length > 0 and all(. == "APPROVED")) then "APPROVED"
        else "PENDING"
        end
    ' 2>/dev/null || echo "PENDING"
  )"
  rank_input+="${pr_number}"$'\t'"${created_at}"$'\t'"${pr_branch}"$'\t'"${review_state}"$'\t'"${pr_title}"$'\n'
done <<< "$review_rows"

top_prs="$(
  RANK_INPUT="$rank_input" python3 - "$TOP_N" <<'PY'
import datetime as dt
import os
import sys

top_n = int(sys.argv[1])
rows = []
for raw in os.environ.get("RANK_INPUT", "").splitlines():
    if not raw.strip():
      continue
    pr_number, created_at, branch, review_state, title = raw.split("\t", 4)
    weight = {"CHANGES_REQUESTED": 0, "PENDING": 1, "APPROVED": 2}.get(review_state, 1)
    try:
      created = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
      created_key = created.timestamp()
    except Exception:
      created_key = float("inf")
    rows.append((weight, created_key, int(pr_number), branch, review_state, title))

rows.sort(key=lambda item: (item[0], item[1], item[2]))
for weight, _, pr_number, branch, review_state, title in rows[:top_n]:
    print(f"{pr_number}\t{branch}\t{review_state}\t{title}")
PY
)"

tmux_sessions="$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
if [[ -z "$tmux_sessions" ]]; then
  tmux_sessions=0
fi
graphql_remaining="$(gh api rate_limit --jq '.resources.graphql.remaining' 2>/dev/null || echo 0)"

echo ""
printf "%-6s %-18s %-12s %-12s %s\n" "PR #" "Review" "Coverage" "Action" "Title"
printf "%-6s %-18s %-12s %-12s %s\n" "------" "------" "--------" "------" "-----"

covered_count=0
blocked_count=0
spawned_count=0
declare -a failures

while IFS=$'\t' read -r pr_number pr_branch review_state pr_title; do
  [[ -z "$pr_number" ]] && continue

  title_short="$(printf '%s' "$pr_title" | cut -c1-55)"
  if [[ ${#pr_title} -gt 55 ]]; then
    title_short="${title_short}..."
  fi

  coverage="UNCOVERED"
  action="none"
  claim_failure=""

  if [[ -v session_pr_map["$pr_number"] ]]; then
    coverage="${session_pr_map[$pr_number]}"
    action="covered"
    covered_count=$((covered_count + 1))
    printf "%-6s %-18s %-12s %-12s %s\n" "#$pr_number" "$review_state" "$coverage" "$action" "$title_short"
    continue
  fi

  claim_failure="$(latest_claim_failure_for_pr "$pr_number")"
  if [[ -n "$claim_failure" ]]; then
    coverage="BLOCKED"
    action="claim_failed"
    blocked_count=$((blocked_count + 1))
    failures+=("#$pr_number blocked: $claim_failure")
    printf "%-6s %-18s %-12s %-12s %s\n" "#$pr_number" "$review_state" "$coverage" "$action" "$title_short"
    continue
  fi

  if [[ "$SPAWN_MISSING" != "1" ]]; then
    failures+=("#$pr_number uncovered")
    printf "%-6s %-18s %-12s %-12s %s\n" "#$pr_number" "$review_state" "$coverage" "$action" "$title_short"
    continue
  fi

  if [[ "$tmux_sessions" -gt "$TMUX_SESSION_BUDGET" ]]; then
    action="tmux_budget"
    failures+=("#$pr_number uncovered: tmux_sessions=$tmux_sessions exceeds budget=$TMUX_SESSION_BUDGET")
    printf "%-6s %-18s %-12s %-12s %s\n" "#$pr_number" "$review_state" "$coverage" "$action" "$title_short"
    continue
  fi

  if ! [[ "$graphql_remaining" =~ ^[0-9]+$ ]] || [ "$graphql_remaining" -le 0 ]; then
    action="graphql_zero"
    failures+=("#$pr_number uncovered: graphql_remaining=$graphql_remaining")
    printf "%-6s %-18s %-12s %-12s %s\n" "#$pr_number" "$review_state" "$coverage" "$action" "$title_short"
    continue
  fi

  if ao spawn --project "$PROJECT" --claim-pr "$pr_number" >/tmp/ensure-top-pr-coverage-"$pr_number".out 2>&1; then
    action="spawned"
    spawned_count=$((spawned_count + 1))
    covered_count=$((covered_count + 1))
  else
    action="spawn_failed"
    spawn_err="$(tail -n 1 /tmp/ensure-top-pr-coverage-"$pr_number".out 2>/dev/null || echo "spawn failed")"
    failures+=("#$pr_number spawn failed: $spawn_err")
  fi
  printf "%-6s %-18s %-12s %-12s %s\n" "#$pr_number" "$review_state" "$coverage" "$action" "$title_short"
done <<< "$top_prs"

echo ""
echo "top_n=$TOP_N covered_or_spawned=$covered_count blocked=$blocked_count spawned=$spawned_count tmux_sessions=$tmux_sessions graphql_remaining=$graphql_remaining"

if (( covered_count >= TOP_N )); then
  echo "Top-$TOP_N coverage target satisfied."
  exit 0
fi

if ((${#failures[@]} > 0)); then
  printf '%s\n' "${failures[@]}"
fi
exit 1
