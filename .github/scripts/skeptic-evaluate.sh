#!/bin/bash
# =============================================================================
# skeptic-evaluate.sh — 7-green evaluation and merge for skeptic-cron.yml
# =============================================================================
# Called by the skeptic-cron workflow after trigger comments are posted.
# Evaluates gates 6 (evidence) and 7 (skeptic verdict), then merges if 7-green.
#
# Inputs (env):
#   PR_JSON              — JSON array of PRs from list_prs step
#   GITHUB_TOKEN         — GitHub token for API calls
#   GITHUB_REPOSITORY    — owner/repo
#   GITHUB_REPOSITORY_OWNER
#   GITHUB_RUN_ID
#   STALE_HOURS          — hours before a PR is considered stale
#   SKEPTIC_BOT_AUTHOR   — author login for skeptic verdict comments
#   SKEPTIC_CRON_AUTO_MERGE — 'true' to auto-merge, 'false' to skip
#   SKEPTIC_MERGE_DENYLIST — comma-separated PR numbers to never merge
# =============================================================================
set -euo pipefail

MERGED=0

for PR in $(echo "$PR_JSON" | jq -r '.[] | @base64'); do
  PR_DATA=$(echo "$PR" | base64 -d)
  PR_NUM=$(echo "$PR_DATA" | jq -r '.number')
  PR_TITLE=$(echo "$PR_DATA" | jq -r '.title')
  PR_SHA=$(echo "$PR_DATA" | jq -r '.head.sha')

  echo ""
  echo "--- Checking 7-green for PR #${PR_NUM}: ${PR_TITLE} ---"

  # Track PR age for staleness reporting
  PR_DETAIL=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" \
    --jq '{created_at: .created_at}' 2>/dev/null || echo '{"created_at":null}')
  CREATED=$(echo "$PR_DETAIL" | jq -r '.created_at')
  if [ "$CREATED" != "null" ] && [ -n "$CREATED" ]; then
    epoch_now=$(date +%s)
    epoch_created=$(date -d "$CREATED" +%s 2>/dev/null) || epoch_created=0
    if [ "$epoch_created" -gt 0 ]; then
      age_sec=$((epoch_now - epoch_created))
      AGE_HRS=$(printf '%s' "$age_sec" | awk '{printf "%.1f", $1/3600}')
      STALE_STATUS="unknown"
      AGE_INT=$(echo "$AGE_HRS" | cut -d. -f1)
      if [ "${AGE_INT:-0}" -ge "${STALE_HOURS:-3}" ]; then
        STALE_STATUS="STALE"
      else
        STALE_STATUS="FRESH"
      fi
      echo "  [AGE] PR #${PR_NUM}: age=${AGE_HRS}h, status=${STALE_STATUS}"
    fi
  fi

  # 1. CI green
  HEAD_SHA=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" --jq '.head.sha')
  CI_STATUS=$(gh api repos/$GITHUB_REPOSITORY/commits/"$HEAD_SHA"/status \
    --jq '.state' 2>/dev/null || echo "error")
  CI_RESULT=$([ "$CI_STATUS" = "success" ] && echo "PASS" || echo "FAIL (state=$CI_STATUS)")
  echo "  [1] CI green:          $CI_RESULT"

  # 2. No merge conflicts
  PR_DATA2=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" \
    --jq '{mergeable: .mergeable, merged: .merged}' 2>/dev/null)
  MERGEABLE=$(echo "$PR_DATA2" | jq -r '.mergeable // "unknown"')
  MERGED_FLAG=$(echo "$PR_DATA2" | jq -r '.merged // false')
  MERGE_CONFLICT=$(if [ "$MERGEABLE" = "true" ] || [ "$MERGED_FLAG" = "true" ]; then echo "PASS"; else echo "FAIL (mergeable=$MERGEABLE)"; fi)
  echo "  [2] No merge conflicts: $MERGE_CONFLICT"

  # 3. CR APPROVED
  set +e
  LATEST_CR_PIPELINE=$(set -o pipefail; gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM"/reviews \
    --paginate 2>/dev/null \
    | jq -rs 'add | [.[] | select((.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai") and .state != "COMMENTED")] | sort_by(.submitted_at) | last | .state // "none"' 2>&1)
  LATEST_CR_EXIT=$?
  set -e
  if [ $LATEST_CR_EXIT -ne 0 ]; then
    CR_APPROVED="FAIL (jq exit=$LATEST_CR_EXIT)"
  else
    LATEST_CR="${LATEST_CR_PIPELINE%$'\n'}"
    if [ "$LATEST_CR" = "APPROVED" ]; then
      CR_APPROVED="PASS"
    elif [ "$LATEST_CR" != "none" ]; then
      CR_APPROVED="FAIL (state=$LATEST_CR)"
    else
      HEAD_COMMITTED_AT=$(gh api repos/$GITHUB_REPOSITORY/commits/"$PR_SHA" \
        --jq '.commit.committer.date // ""' 2>/dev/null || echo "")
      CR_STATUS=$(gh api repos/$GITHUB_REPOSITORY/commits/"$PR_SHA"/status \
        --jq '.statuses | map(select(.context == "CodeRabbit" and .state == "success")) | sort_by(.updated_at) | last | .state // "none"' \
        2>/dev/null || echo "none")
      CR_APPROVE_COMMENT="none"
      if [ -n "$HEAD_COMMITTED_AT" ]; then
        set +e
        CR_APPROVE_COMMENT=$(set -o pipefail; gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments \
          --paginate 2>/dev/null \
          | jq -rs --arg since "$HEAD_COMMITTED_AT" 'add | [.[] | select((.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai") and .created_at >= $since and (.body | test("^\s*\[approve\]\s*$"; "i")))] | sort_by(.created_at) | last | if . then "APPROVED" else "none" end' \
          2>&1)
        CR_APPROVE_COMMENT_EXIT=$?
        set -e
        if [ $CR_APPROVE_COMMENT_EXIT -ne 0 ]; then
          CR_APPROVE_COMMENT="lookup_error"
        else
          CR_APPROVE_COMMENT="${CR_APPROVE_COMMENT%$'\n'}"
        fi
      fi
      if [ "$CR_STATUS" = "success" ] && [ "$CR_APPROVE_COMMENT" = "APPROVED" ]; then
        CR_APPROVED="PASS"
      else
        CR_APPROVED="FAIL (state=$LATEST_CR status=$CR_STATUS comment=$CR_APPROVE_COMMENT)"
      fi
    fi
  fi
  echo "  [3] CR APPROVED:        $CR_APPROVED"

  # 4. Bugbot clean
  BUGBOT_ERRORS=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM"/comments \
    --jq '[.[] | select(.user.login == "cursor[bot]" and (.body | test("error"; "i")))] | length' 2>/dev/null || echo 0)
  BUGBOT_STATUS=$(if [ "$BUGBOT_ERRORS" = "0" ] || [ -z "$BUGBOT_ERRORS" ]; then echo "PASS"; else echo "FAIL ($BUGBOT_ERRORS error(s))"; fi)
  echo "  [4] Bugbot clean:       $BUGBOT_STATUS"

  # 5. Inline comments resolved (GraphQL)
  PR_AUTHOR=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" --jq '.user.login')
  REPO_NAME="${GITHUB_REPOSITORY#*/}"
  GQL_RESULT=$(gh api graphql -f query='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              isResolved
              comments(first: 50) {
                pageInfo { hasNextPage }
                nodes { author { login } body }
              }
            }
          }
        }
      }
    }
  ' -f owner="$GITHUB_REPOSITORY_OWNER" -f name="$REPO_NAME" -F number="$PR_NUM" 2>/dev/null)
  if [ -z "$GQL_RESULT" ]; then
    UNRESOLVED="__GQL_ERROR__"
  elif [ "$(echo "$GQL_RESULT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')" = "true" ] || [ "$(echo "$GQL_RESULT" | jq -r '[.data.repository.pullRequest.reviewThreads.nodes[].comments.pageInfo.hasNextPage | select(. == true)] | length')" -gt 0 ]; then
    UNRESOLVED="__TRUNCATED__"
  else
    UNRESOLVED=$(echo "$GQL_RESULT" | jq -r "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | .comments.nodes[] | select(.author.login != null and (.author.login | ascii_downcase) != (\"$PR_AUTHOR\" | ascii_downcase) and (.body | test(\"^\s*(nit:|nitpick)\"; \"i\") | not))] | length")
  fi
  if [ "$UNRESOLVED" = "__GQL_ERROR__" ] || [ "$UNRESOLVED" = "__TRUNCATED__" ]; then
    COMMENTS_STATUS="FAIL (graphql-error or pagination-truncated)"
  elif [ "$UNRESOLVED" = "0" ] || [ -z "$UNRESOLVED" ]; then
    COMMENTS_STATUS="PASS"
  else
    COMMENTS_STATUS="FAIL ($UNRESOLVED unresolved)"
  fi
  echo "  [5] Comments resolved:   $COMMENTS_STATUS"

  # 6. Evidence review (fail-closed)
  EVIDENCE_APPROVED=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM"/reviews \
    --jq '[.[] | select(.user.login == "evidence-review-bot" and .state == "APPROVED" and .commit_id == "'"$PR_SHA"'")] | length' 2>/dev/null || echo 0)

  EVIDENCE_CHECKS_RAW=$(gh api repos/$GITHUB_REPOSITORY/commits/"$PR_SHA"/check-runs \
    --paginate \
    2>/dev/null || echo "[]")
  EVIDENCE_GATE_CONCLUSION=$(echo "$EVIDENCE_CHECKS_RAW" | jq -sr \
    '[.[].check_runs[]? | select(.name == "Evidence Gate")] | sort_by(.started_at) | last | if . == null then "missing" elif .conclusion == null then "" else .conclusion end' 2>/dev/null || echo "missing")

  if [ "${EVIDENCE_APPROVED:-0}" -gt 0 ]; then
    EVIDENCE_STATUS="PASS (evidence-review-bot approved @HEAD)"
  elif [ "$EVIDENCE_GATE_CONCLUSION" = "success" ]; then
    EVIDENCE_STATUS="PASS (Evidence Gate check passed)"
  elif [ "$EVIDENCE_GATE_CONCLUSION" = "missing" ]; then
    EVIDENCE_STATUS="FAIL (Evidence Gate check not found)"
  elif [ -z "$EVIDENCE_GATE_CONCLUSION" ]; then
    EVIDENCE_STATUS="FAIL (Evidence Gate in progress — not yet concluded)"
  else
    EVIDENCE_STATUS="FAIL (Evidence Gate: $EVIDENCE_GATE_CONCLUSION)"
  fi
  echo "  [6] Evidence review:    $EVIDENCE_STATUS"

  # 7. Skeptic verdict — look for VERDICT comment from AO worker.
  SKEPTIC_VERDICT=$(gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments \
    --paginate \
    --jq "[.[] | select(.user.login == \"${SKEPTIC_BOT_AUTHOR}\" and (.body | test(\"VERDICT:\"; \"i\")) and (.body | test(\"skeptic-cron-trigger-\" + \"$PR_SHA\"; \"i\"))) | .body] | last // empty" 2>/dev/null || echo "")
  if echo "$SKEPTIC_VERDICT" | grep -qi "VERDICT: PASS"; then
    SKEPTIC_STATUS="PASS"
  elif echo "$SKEPTIC_VERDICT" | grep -qi "VERDICT: FAIL"; then
    SKEPTIC_STATUS="FAIL"
  else
    FALLBACK_TRIGGER_RE="skeptic-cron-trigger-${PR_SHA}"
    SKEPTIC_VERDICT=$(gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments \
      --paginate \
      --jq "[.[] | select((.user.login == \"${SKEPTIC_BOT_AUTHOR}\" or .user.login == \"github-actions[bot]\") and (.body | test(\"VERDICT:\"; \"i\")) and (.body | test(\"$FALLBACK_TRIGGER_RE\"; \"i\"))) | .body] | last // empty" 2>/dev/null || echo "")
    if echo "$SKEPTIC_VERDICT" | grep -qi "VERDICT: PASS"; then
      SKEPTIC_STATUS="PASS"
    elif echo "$SKEPTIC_VERDICT" | grep -qi "VERDICT: FAIL"; then
      SKEPTIC_STATUS="FAIL"
    else
      SKEPTIC_STATUS="FAIL"
    fi
  fi
  echo "  [7] Skeptic verdict:    $SKEPTIC_STATUS"

  # All gates must PASS; infra failures emit VERDICT: FAIL (fail-closed)
  ALL_PASS=true
  for COND in "$CI_RESULT" "$MERGE_CONFLICT" "$CR_APPROVED" "$BUGBOT_STATUS" "$COMMENTS_STATUS" "$EVIDENCE_STATUS"; do
    if echo "$COND" | grep -qi "FAIL"; then
      ALL_PASS=false
      break
    fi
  done
  if echo "$SKEPTIC_STATUS" | grep -qi "FAIL"; then
    ALL_PASS=false
  fi

  if [ "$ALL_PASS" = "true" ]; then
    echo ""
    echo "*** PR #${PR_NUM} is 7-green! Merging... ***"
    if [ "$MERGED_FLAG" = "true" ]; then
      echo "Already merged — skipping"
    else
      # SHA safety check
      CURRENT_SHA=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" --jq '.head.sha' 2>/dev/null)
      if [ "$CURRENT_SHA" != "$PR_SHA" ]; then
        echo "HEAD SHA changed ($PR_SHA -> $CURRENT_SHA) — skipping merge (will re-evaluate next cycle)"
        continue
      fi
      # Check denylist
      if [ -n "$SKEPTIC_MERGE_DENYLIST" ]; then
        if echo ",$SKEPTIC_MERGE_DENYLIST," | grep -q ",$PR_NUM,"; then
          echo "PR #${PR_NUM} is on merge denylist — skipping"
          continue
        fi
      fi
      # Check auto-merge flag
      if [ "${SKEPTIC_CRON_AUTO_MERGE:-true}" != "true" ] && [ "${SKEPTIC_CRON_AUTO_MERGE:-true}" != "1" ]; then
        echo "SKEPTIC_CRON_AUTO_MERGE=false — skipping merge (7-green evaluation complete)"
        continue
      fi
      MERGE_RESULT=$(gh pr merge "$PR_NUM" \
        --repo $GITHUB_REPOSITORY \
        --squash --admin \
        --delete-branch \
        2>&1 || echo "MERGE_FAILED")
      if echo "$MERGE_RESULT" | grep -Ei "MERGE_FAILED|error"; then
        echo "Merge failed for PR #${PR_NUM}: $MERGE_RESULT"
      else
        echo "Successfully merged PR #${PR_NUM}"
        MERGED=$((MERGED + 1))
      fi
    fi
  else
    echo "PR #${PR_NUM} not yet merge-ready — skipping"
  fi
done

echo "merged_count=$MERGED" >> "$GITHUB_OUTPUT"
echo ""
echo "=== Skeptic cron complete: $MERGED PR(s) merged ==="
