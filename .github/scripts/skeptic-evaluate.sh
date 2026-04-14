#!/bin/bash
# Extracted from .github/workflows/skeptic-cron.yml Step 3 (check 7-green and merge)
# This was inlined as a ~417-line run: block; extracting to a script file
# avoids GitHub Actions expression-length limits that can block workflow dispatch.
#
# CONTEXT: This script is now maintained in jleechanorg/agent-orchestrator
# and used by reusable workflows.
set -euo pipefail

MERGED=0

for PR in $(echo "$PR_JSON" | jq -r '.[] | @base64'); do
  PR_DATA=$(echo "$PR" | base64 -d)
  PR_NUM=$(echo "$PR_DATA" | jq -r '.number')
  PR_TITLE=$(echo "$PR_DATA" | jq -r '.title')
  # Extract PR_AUTHOR early for evidence request from the listed PR payload.
  PR_AUTHOR=$(echo "$PR_DATA" | jq -r '.user.login // "ghost"')

  echo ""
  echo "--- Checking 7-green for PR #${PR_NUM}: ${PR_TITLE} ---"

  # Track PR age for staleness reporting
  PR_DETAIL=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" \
    --jq '{created_at: .created_at}' 2>/dev/null || echo '{"created_at":null}')
  CREATED=$(echo "$PR_DETAIL" | jq -r '.created_at')
  if [ "$CREATED" != "null" ] && [ -n "$CREATED" ]; then
    epoch_now=$(date +%s)
    # macOS 'date' vs Linux 'date' compatibility: macOS doesn't support -d
    # GHA self-hosted runners are likely Linux, but let's be safe.
    if [[ "$OSTYPE" == "darwin"* ]]; then
      epoch_created=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$CREATED" +%s 2>/dev/null) || epoch_created=0
    else
      epoch_created=$(date -d "$CREATED" +%s 2>/dev/null) || epoch_created=0
    fi
    
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
  HEAD_SHA=$(echo "$PR_DATA" | jq -r '.head.sha // empty')
  if [ -z "$HEAD_SHA" ]; then
    HEAD_SHA=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" --jq '.head.sha' 2>/dev/null || echo "")
  fi
  if [ -z "$HEAD_SHA" ]; then
    echo "  [SKIP] Cannot determine HEAD SHA for PR #$PR_NUM"
    continue
  fi
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

  # 3. CR APPROVED — prefer formal review state, then current-head status + approve comment.
  LATEST_CR_RAW=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM"/reviews \
    --paginate 2>/dev/null \
    | jq -rs 'add | [.[] | select((.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai") and .state != "COMMENTED")] | sort_by(.submitted_at) | last | .state // "none"' 2>&1)
  LATEST_CR_EXIT=$?
  if [ $LATEST_CR_EXIT -ne 0 ]; then
    CR_STATE="ERROR"
  else
    CR_STATE="${LATEST_CR_RAW%$'\n'}"
  fi
  if [ "$CR_STATE" = "APPROVED" ]; then
    CR_APPROVED="PASS"
  elif [ "$CR_STATE" != "none" ]; then
    CR_APPROVED="FAIL (state=$CR_STATE)"
  else
    HEAD_COMMITTED_AT=$(gh api repos/$GITHUB_REPOSITORY/commits/"$HEAD_SHA" \
      --jq '.commit.committer.date // ""' 2>/dev/null || echo "")
    CR_STATUS=$(gh api repos/$GITHUB_REPOSITORY/commits/"$HEAD_SHA"/status \
      --jq '.statuses | map(select(.context == "CodeRabbit" and .state == "success")) | sort_by(.updated_at) | last | .state // "none"' \
      2>/dev/null || echo "none")
    CR_APPROVE_COMMENT="none"
    if [ -n "$HEAD_COMMITTED_AT" ]; then
      CR_APPROVE_COMMENT=$(gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments \
        --paginate 2>/dev/null \
        | jq -rs --arg since "$HEAD_COMMITTED_AT" 'add | [.[] | select((.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai") and .created_at >= $since and (.body | test("(?m)^\\s*\\[approve\\]\\s*$"; "i")))] | sort_by(.created_at) | last | if . then "APPROVED" else "none" end' \
        2>/dev/null || echo "none")
    fi
    if [ "$CR_STATUS" = "success" ] && [ "$CR_APPROVE_COMMENT" = "APPROVED" ]; then
      CR_STATE="APPROVED(status+comment)"
      CR_APPROVED="PASS"
    else
      CR_APPROVED="FAIL (state=$CR_STATE status=$CR_STATUS comment=$CR_APPROVE_COMMENT)"
    fi
  fi
  echo "  [3] CR APPROVED:        $CR_APPROVED"

  # 4. Bugbot clean — use CI check-run conclusion scoped to HEAD_SHA.
  BUGBOT_CONCLUSION=$(gh api repos/$GITHUB_REPOSITORY/commits/"$HEAD_SHA"/check-runs \
    --paginate 2>/dev/null \
    | jq -rs '[.[] | .check_runs[]?] | map(select(.name | test("Cursor Bugbot"; "i"))) | sort_by(.completed_at) | last | .conclusion // "none"' \
    2>/dev/null || echo "none")
  if [ "$BUGBOT_CONCLUSION" = "success" ] || [ "$BUGBOT_CONCLUSION" = "neutral" ] || [ "$BUGBOT_CONCLUSION" = "skipped" ]; then
    BUGBOT_STATUS="PASS"
  else
    BUGBOT_STATUS="FAIL (bugbot=$BUGBOT_CONCLUSION)"
  fi
  echo "  [4] Bugbot clean:       $BUGBOT_STATUS"

  # 5. Inline comments resolved (GraphQL — REST lacks isResolved)
  GATE5_PR_AUTHOR="$PR_AUTHOR"
  if [ "$GATE5_PR_AUTHOR" = "ghost" ]; then
    COMMENTS_STATUS="FAIL (missing-author)"
  else
    REPO_NAME="${GITHUB_REPOSITORY#*/}"
    UNRESOLVED=0; GQL_ERROR=0; CURSOR=""; PAGE_COUNT=0; MAX_PAGES=50
    while true; do
      PAGE_COUNT=$((PAGE_COUNT + 1))
      if [ "$PAGE_COUNT" -gt "$MAX_PAGES" ]; then GQL_ERROR=1; break; fi
      if [ -z "$CURSOR" ]; then
        GQL_RESULT=$(gh api graphql -f query='
          query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  pageInfo { hasNextPage endCursor }
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
      else
        GQL_RESULT=$(gh api graphql -f query='
          query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $cursor) {
                  pageInfo { hasNextPage endCursor }
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
        ' -f owner="$GITHUB_REPOSITORY_OWNER" -f name="$REPO_NAME" -F number="$PR_NUM" -f cursor="$CURSOR" 2>/dev/null)
      fi
      if [ -z "$GQL_RESULT" ] || ! echo "$GQL_RESULT" | jq -e '
        (.errors | not) and
        (.data.repository.pullRequest.reviewThreads.pageInfo != null)
      ' >/dev/null; then
        GQL_ERROR=1; break
      fi
      if [ "$(echo "$GQL_RESULT" | jq -r '[.data.repository.pullRequest.reviewThreads.nodes[].comments.pageInfo.hasNextPage | select(. == true)] | length')" -gt 0 ]; then
        GQL_ERROR=1; break
      fi
      PAGE_UNRESOLVED=$(echo "$GQL_RESULT" | jq -r \
        --arg author "$GATE5_PR_AUTHOR" \
        '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | .comments.nodes[] | select(.author.login != null and (.author.login | ascii_downcase) != ($author | ascii_downcase) and (.body | test("^\\s*(nit:|nitpick)"; "i") | not))] | length')
      UNRESOLVED=$((UNRESOLVED + PAGE_UNRESOLVED))
      HAS_NEXT=$(echo "$GQL_RESULT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
      if [ "$HAS_NEXT" != "true" ]; then break; fi
      NEXT_CURSOR=$(echo "$GQL_RESULT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
      if [ -z "$NEXT_CURSOR" ] || [ "$NEXT_CURSOR" = "null" ] || [ "$NEXT_CURSOR" = "$CURSOR" ]; then
        GQL_ERROR=1; break
      fi
      CURSOR="$NEXT_CURSOR"
    done
    if [ "$GQL_ERROR" = "1" ]; then
      COMMENTS_STATUS="FAIL (graphql-error)"
    elif [ "${UNRESOLVED:-0}" -gt 0 ]; then
      COMMENTS_STATUS="FAIL ($UNRESOLVED unresolved)"
    else
      COMMENTS_STATUS="PASS"
    fi
  fi
  echo "  [5] Comments resolved:   $COMMENTS_STATUS"

  # 6. Evidence review (fail-closed)
  PR_COMMENTS_BODY=$(gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments --paginate 2>/dev/null | jq -r '.[].body' 2>/dev/null || echo "")
  PR_REVIEWS=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM"/reviews --paginate 2>/dev/null | jq -r '.[].body' 2>/dev/null || echo "")
  PR_BODY=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" --jq '.body' 2>/dev/null || echo "")
  ALL_TEXT=$(printf "%s\n%s\n%s" "$PR_BODY" "$PR_COMMENTS_BODY" "$PR_REVIEWS")

  HAS_VIDEO=false
  if echo "$ALL_TEXT" | grep -qEi 'https?://(([^][:space:]">)]+\.)?(asciinema\.org/a/[^][:space:]">)]+|loom\.com/share/[^][:space:]">)]+|github\.com/[^][:space:]">)]+/(assets|files)/[^][:space:]">)]+|user-attachments\.githubusercontent\.com/[^][:space:]">)]+|gist\.github\.com/[^][:space:]">)]+)|[^][:space:]">)]+\.(mp4|cast|webm|gif)([^a-zA-Z0-9_]|$|[?#][^][:space:]">)]*))'; then
    HAS_VIDEO=true
  fi

  EVIDENCE_APPROVED=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM"/reviews \
    --paginate 2>/dev/null \
    | jq -s --arg sha "$HEAD_SHA" 'add | [.[] | select(.user.login == "evidence-review-bot" and .commit_id == $sha)] | map(select(.state == "APPROVED")) | length' 2>/dev/null || echo 0)

  EVIDENCE_CHECKS_RAW=$(gh api repos/$GITHUB_REPOSITORY/commits/"$HEAD_SHA"/check-runs?per_page=100 \
    --paginate 2>/dev/null || echo "[]")
  EVIDENCE_CHECK_LATEST=$(echo "$EVIDENCE_CHECKS_RAW" | jq -s \
    '[[.[] | .check_runs[]?] | .[]
      | .normalized_name = (.name | ascii_downcase | gsub("[ -]"; ""))
      | select(.normalized_name | test("^evidence(gate|review)$"))
      | {name: .name, normalized_name: .normalized_name, completed_at: (.completed_at // "1970-01-01T00:00:00Z"), id: .id, conclusion: .conclusion}]
    | group_by(.normalized_name)
    | map(max_by(.id) | del(.normalized_name))' 2>/dev/null || echo "[]")
  EVIDENCE_CHECK_TOTAL=$(echo "$EVIDENCE_CHECK_LATEST" | jq 'length' 2>/dev/null || echo 0)
  EVIDENCE_CHECK_PASS=$(echo "$EVIDENCE_CHECK_LATEST" | jq '[.[] | select(.conclusion == "success")] | length' 2>/dev/null || echo 0)

  if [ "${EVIDENCE_APPROVED:-0}" -gt 0 ] && [ "$HAS_VIDEO" = "true" ]; then
    EVIDENCE_STATUS="PASS (evidence-review-bot approved @HEAD and video found)"
  elif [ "${EVIDENCE_CHECK_TOTAL:-0}" -gt 0 ] && [ "${EVIDENCE_CHECK_PASS:-0}" -gt 0 ] && [ "${EVIDENCE_CHECK_PASS:-0}" = "${EVIDENCE_CHECK_TOTAL:-0}" ] && [ "$HAS_VIDEO" = "true" ]; then
    EVIDENCE_STATUS="PASS (all evidence check runs passed and video found)"
  elif [ "$HAS_VIDEO" = "false" ] && { [ "${EVIDENCE_APPROVED:-0}" -gt 0 ] || { [ "${EVIDENCE_CHECK_TOTAL:-0}" -gt 0 ] && [ "${EVIDENCE_CHECK_PASS:-0}" = "${EVIDENCE_CHECK_TOTAL:-0}" ]; }; }; then
    EVIDENCE_STATUS="FAIL (evidence check passed but missing video/terminal recording)"
  elif [ "${EVIDENCE_CHECK_TOTAL:-0}" -gt 0 ]; then
    EVIDENCE_STATUS="FAIL (evidence check present but not all passing: $EVIDENCE_CHECK_PASS/$EVIDENCE_CHECK_TOTAL)"
  else
    _CF_TMPFILE=$(mktemp)
    gh api "repos/$GITHUB_REPOSITORY/pulls/${PR_NUM}/files" \
      --paginate 2>/dev/null | jq -r '.[].filename' 2>/dev/null > "$_CF_TMPFILE"
    _CF_PIPE_STATUS=("${PIPESTATUS[@]}")
    CHANGED_FILES=$(cat "$_CF_TMPFILE"); rm -f "$_CF_TMPFILE"
    if [ "${_CF_PIPE_STATUS[0]}" != "0" ] || [ "${_CF_PIPE_STATUS[1]}" != "0" ]; then
      EVIDENCE_GATE_REQUIRED="true"
    else
      EVIDENCE_GATE_REQUIRED=$(echo "$CHANGED_FILES" | grep -qE '^(testing_(mcp|ui)/|deploy\.sh$|\.github/workflows/evidence-gate\.yml$)' && echo "true" || echo "false")
    fi
    if [ "$EVIDENCE_GATE_REQUIRED" = "false" ] && [ "$HAS_VIDEO" = "true" ]; then
      EVIDENCE_STATUS="PASS (evidence gate N/A for this PR; video/recording found)"
    elif [ "$EVIDENCE_GATE_REQUIRED" = "false" ] && [ "$HAS_VIDEO" = "false" ]; then
      EVIDENCE_STATUS="FAIL (video/terminal recording missing — add gist or recording link to PR)"
    else
      EVIDENCE_STATUS="FAIL (missing evidence approval/check)"
    fi
  fi
  echo "  [6] Evidence review:    $EVIDENCE_STATUS"
  
  if echo "$EVIDENCE_STATUS" | grep -qi "FAIL"; then
    EXISTING_COMMENT_IDS=$(gh api repos/$GITHUB_REPOSITORY/issues/$PR_NUM/comments \
      --paginate 2>/dev/null | jq -r --arg marker "<!-- evidence-required-${PR_NUM} -->" \
      '[.[] | select((.body // "") | contains($marker))] | .[0].id // empty')
    if [ -z "$EXISTING_COMMENT_IDS" ]; then
      EVIDENCE_BODY_FILE=$(mktemp)
      printf '%s\n\n%s\n%s\n\n%s\n\n%s\n\n%s\n\n%s\n' \
        "@$PR_AUTHOR — Merge blocked: Gate 6 (evidence) requires proof per evidence-standards.md" \
        "## Required Evidence:" \
        "1. **Terminal recording** - Record asciinema showing git provenance + code diff + test output" \
        "2. **Evidence bundle** - Create at \`/tmp/<repo>/<branch>/<test-name>/latest/\` with metadata.json, run.json, evidence.md" \
        "3. **For UI changes** - Add browser video (GIF/mp4)" \
        "See: https://github.com/$GITHUB_REPOSITORY/blob/main/.claude/skills/evidence-standards.md" \
        "Post gist URL or drag video to PR. Retrigger: close and reopen. <!-- evidence-required-$PR_NUM -->" \
        > "$EVIDENCE_BODY_FILE"
      gh api repos/$GITHUB_REPOSITORY/issues/$PR_NUM/comments \
        --method POST \
        --field "body=@${EVIDENCE_BODY_FILE}" \
        --jq '.id' > /dev/null 2>&1 || true
      rm -f "$EVIDENCE_BODY_FILE"
      echo "  [6] Evidence request posted to PR #${PR_NUM}"
    else
      echo "  [6] Evidence request already exists, skipping duplicate post"
    fi
  fi

  # 7. Skeptic verdict
  SKEPTIC_RAW=$(gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments \
    --paginate 2>/dev/null || echo "[]")
  SKEPTIC_VERDICT=$(echo "$SKEPTIC_RAW" | jq -s \
    --arg author "$SKEPTIC_BOT_AUTHOR" \
    --arg sha "$HEAD_SHA" \
    'add | map(select(
      (.user.login == $author or .user.login == "github-actions[bot]")
      and (.body | test("VERDICT:"; "i"))
      and (.body | test("skeptic-(cron|gate)-trigger-" + $sha; "i"))
    )) | last.body // empty' 2>/dev/null || echo "")
  if echo "$SKEPTIC_VERDICT" | grep -qi "VERDICT: PASS"; then
    SKEPTIC_STATUS="PASS"
  elif echo "$SKEPTIC_VERDICT" | grep -qi "VERDICT: FAIL"; then
    SKEPTIC_STATUS="FAIL"
  else
    SKEPTIC_STATUS="MISSING"
  fi
  echo "  [7] Skeptic verdict:    $SKEPTIC_STATUS"

  ALL_PASS=true
  for COND in "$CI_RESULT" "$MERGE_CONFLICT" "$CR_APPROVED" "$BUGBOT_STATUS" "$COMMENTS_STATUS" "$EVIDENCE_STATUS"; do
    if echo "$COND" | grep -qi "FAIL"; then
      ALL_PASS=false
      break
    fi
  done
  if echo "$SKEPTIC_STATUS" | grep -qi "FAIL\|MISSING"; then
    ALL_PASS=false
  fi

  if [ "$ALL_PASS" = "true" ]; then
    echo ""
    SKIP_MERGE=false
    if [ "${SKEPTIC_CRON_AUTO_MERGE:-true}" = "false" ] || [ "${SKEPTIC_CRON_AUTO_MERGE:-true}" = "0" ]; then
      SKIP_MERGE=true
      echo "*** PR #${PR_NUM} is 7-green — merge skipped (SKEPTIC_CRON_AUTO_MERGE=false) ***"
    elif [ -n "$SKEPTIC_MERGE_DENYLIST" ]; then
      IFS=',' read -ra _deny <<< "$SKEPTIC_MERGE_DENYLIST"
      for _d in "${_deny[@]}"; do
        _d="$(echo "$_d" | tr -d '[:space:]')"
        [ -z "$_d" ] && continue
        if [ "$_d" = "$PR_NUM" ]; then
          SKIP_MERGE=true
          echo "*** PR #${PR_NUM} is 7-green — merge skipped (SKEPTIC_MERGE_DENYLIST) ***"
          break
        fi
      done
    fi
    if [ "$SKIP_MERGE" = "false" ]; then
      echo "*** PR #${PR_NUM} is 7-green! Merging... ***"
      echo "    Skeptic verdict that triggered merge: $(echo "$SKEPTIC_VERDICT" | grep -i "VERDICT:" | head -1)"
      if [ "$MERGED_FLAG" = "true" ]; then
        echo "Already merged — skipping"
      else
        CURRENT_HEAD=$(gh api repos/$GITHUB_REPOSITORY/pulls/"$PR_NUM" --jq '.head.sha' 2>/dev/null || echo "")
        if [ "$CURRENT_HEAD" != "$HEAD_SHA" ]; then
          echo "Head changed from ${HEAD_SHA:0:7} to ${CURRENT_HEAD:0:7} — skipping merge (verdict may be stale)"
          continue
        fi
        MERGE_RESULT=$(gh pr merge "$PR_NUM" \
          --repo $GITHUB_REPOSITORY \
          --squash --admin \
          --match-head-commit "$CURRENT_HEAD" \
          --delete-branch \
          2>&1 || echo "MERGE_FAILED")
        if echo "$MERGE_RESULT" | grep -Ei "MERGE_FAILED|error"; then
          echo "Merge failed for PR #${PR_NUM}: $MERGE_RESULT"
        else
          echo "Successfully merged PR #${PR_NUM}"
          MERGED=$((MERGED + 1))

          MERGE_COMMENT_FILE=$(mktemp)
          printf '🤖 **skeptic-cron merged this PR**\n\n' > "$MERGE_COMMENT_FILE"
          printf '> Merged by skeptic-cron at %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$MERGE_COMMENT_FILE"
          VERDICT_LINE=$(echo "$SKEPTIC_VERDICT" | grep -i "^[[:space:]]*VERDICT:" | head -1 | sed 's/^[[:space:]]*//' || echo "VERDICT: UNKNOWN")
          printf '> Triggered by: %s\n' "$VERDICT_LINE" >> "$MERGE_COMMENT_FILE"
          printf '> Run: https://github.com/%s/actions/runs/%s\n' "$GITHUB_REPOSITORY" "$GITHUB_RUN_ID" >> "$MERGE_COMMENT_FILE"
          printf '<!-- skeptic-cron-merged-%d-%s -->\n' "$PR_NUM" "${CURRENT_HEAD:0:8}" >> "$MERGE_COMMENT_FILE"
          
          if ! gh api repos/$GITHUB_REPOSITORY/issues/"$PR_NUM"/comments \
            --method POST \
            --field "body=@${MERGE_COMMENT_FILE}" \
            --jq '.id' > /dev/null 2>&1; then
            echo "WARNING: Failed to post merge notification comment on PR #${PR_NUM}"
          fi
          rm -f "$MERGE_COMMENT_FILE"
        fi
      fi
    fi
  else
    echo "PR #${PR_NUM} not yet merge-ready — skipping"
  fi
done

echo "merged_count=$MERGED" >> "$GITHUB_OUTPUT"
echo ""
echo "=== Skeptic cron complete: $MERGED PR(s) merged ==="
