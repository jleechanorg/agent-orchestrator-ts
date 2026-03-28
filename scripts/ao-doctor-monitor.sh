#!/bin/bash
# ao-doctor-monitor — Extended health monitor wrapping ao doctor
# Phase 1: Fast deterministic checks (<10s)
# Phase 2: LLM inference for subjective analysis (proposals only, no decisions)
#
# Bead: bd-92j
# Modeled after: ~/.openclaw/monitor-agent.sh, ~/.openclaw/health-check.sh
# Requires: Bash 4+ (for associative arrays), Node 20+, gh CLI, tmux

set -uo pipefail

# Bash 4+ check (associative arrays used throughout)
if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "ERROR: ao-doctor-monitor requires Bash 4+. detected: $BASH_VERSION" >&2
  exit 1
fi
_bash_major="${BASH_VERSION%%.*}"
if [[ "$_bash_major" -lt 4 ]]; then
  echo "ERROR: ao-doctor-monitor requires Bash 4+. detected: $BASH_VERSION" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Cross-platform timeout helper (timeout/gtimeout may not be available on macOS)
# ---------------------------------------------------------------------------

_run_with_timeout() {
  local timeout_sec="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_sec" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_sec" "$@"
  else
    # Last resort: bash wait loop — runs cmd in background, kills it after timeout
    local cmd=("$@")
    "${cmd[@]}" &
    local pid=$!
    (
      local elapsed=0
      while kill -0 "$pid" 2>/dev/null && [ "$elapsed" -lt "$timeout_sec" ]; do
        sleep 1
        elapsed=$((elapsed + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null
        sleep 2
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        exit 124
      fi
    ) &
    local watcher=$!
    wait "$pid" 2>/dev/null
    local rc=$?
    kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
    return $rc
  fi
}

# ---------------------------------------------------------------------------
# Configuration (all overridable via env vars)
# ---------------------------------------------------------------------------

AO_CONFIG_PATH="${AO_CONFIG_PATH:-}"
AO_DOCTOR_SLACK_CHANNEL="${AO_DOCTOR_SLACK_CHANNEL:-#openclaw-health}"
AO_DOCTOR_PHASE2_ENABLE="${AO_DOCTOR_PHASE2_ENABLE:-0}"
AO_DOCTOR_PHASE2_TIMEOUT="${AO_DOCTOR_PHASE2_TIMEOUT:-60}"
AO_DOCTOR_RATE_LIMIT_WARN="${AO_DOCTOR_RATE_LIMIT_WARN:-500}"
AO_DOCTOR_MAX_SESSIONS_PER_PR="${AO_DOCTOR_MAX_SESSIONS_PER_PR:-2}"
AO_DOCTOR_LOG="${AO_DOCTOR_LOG:-/tmp/ao-doctor-monitor.log}"
AO_DOCTOR_QUIET="${AO_DOCTOR_QUIET:-0}"
# Repo to check PRs for — override if multi-project
AO_DOCTOR_REPO="${AO_DOCTOR_REPO:-}"
# PR staleness threshold in hours (warn if PR older than this with no worker)
AO_DOCTOR_STALE_HOURS="${AO_DOCTOR_STALE_HOURS:-3}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
PHASE1_FAILURES=()
REPORT_LINES=()
SLACK_STALE_PR_COUNT=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ts() { date '+%Y-%m-%d %H:%M:%S'; }

log() {
  local line
  line="[$(ts)] $*"
  echo "$line" >> "$AO_DOCTOR_LOG"
  if [ "$AO_DOCTOR_QUIET" != "1" ]; then
    echo "$line"
  fi
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  REPORT_LINES+=("PASS $1")
  log "PASS $1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  REPORT_LINES+=("WARN $1")
  PHASE1_FAILURES+=("WARN: $1")
  log "WARN $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  REPORT_LINES+=("FAIL $1")
  PHASE1_FAILURES+=("FAIL: $1")
  log "FAIL $1"
}

# Resolve the canonical config path
resolve_config() {
  if [ -n "$AO_CONFIG_PATH" ] && [ -f "$AO_CONFIG_PATH" ]; then
    echo "$AO_CONFIG_PATH"
    return 0
  fi
  # Walk up from CWD
  local d="$PWD"
  while [ "$d" != "/" ]; do
    if [ -f "$d/agent-orchestrator.yaml" ]; then
      echo "$d/agent-orchestrator.yaml"
      return 0
    fi
    d="$(dirname "$d")"
  done
  # Home dir locations (canonical paths used by this repo)
  for p in "$HOME/.openclaw/agent-orchestrator.yaml" \
           "$HOME/agent-orchestrator.yaml" \
           "$HOME/.agent-orchestrator.yaml"; do
    if [ -f "$p" ]; then
      # Resolve symlinks safely (no shell injection)
      local resolved
      resolved="$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$p" 2>/dev/null \
        || readlink -f "$p" 2>/dev/null \
        || echo "$p")"
      echo "$resolved"
      return 0
    fi
  done
  return 1
}

# Extract repo list from config for PR checks
detect_repos() {
  if [ -n "$AO_DOCTOR_REPO" ]; then
    echo "$AO_DOCTOR_REPO"
    return
  fi
  local cfg="$1"
  # Parse repo fields from yaml (simple grep, no yq dependency)
  grep -E '^[[:space:]]+repo:' "$cfg" 2>/dev/null | sed 's/.*repo:[[:space:]]*//' | tr -d '"' | tr -d "'"
}

# ---------------------------------------------------------------------------
# Phase 1 Checks
# ---------------------------------------------------------------------------

check_ao_doctor() {
  log "--- Running ao doctor (baseline) ---"
  # Run in subshell so errexit state is always clean; never set -e in this function
  local out rc
  rc=0
  out=$(ao doctor 2>&1) || rc=$?
  local fails warns
  # grep -c exits 1 when zero lines match; capture matches count safely
  fails=$(echo "$out" | grep -c "^FAIL") || fails=0
  warns=$(echo "$out" | grep -c "^WARN") || warns=0
  if [ "$rc" -ne 0 ] && [ "$fails" -gt 0 ]; then
    fail "ao doctor: ${fails} failures, command exited with code $rc (run 'ao doctor' for details)"
  elif [ "$rc" -ne 0 ] && [ "$fails" -eq 0 ] && [ "$warns" -eq 0 ]; then
    fail "ao doctor: non-zero exit ($rc) with no FAIL/WARN output (ao may be missing or crashed)"
  elif [ "$fails" -gt 0 ]; then
    fail "ao doctor: ${fails} failures (run 'ao doctor' for details)"
  elif [ "$warns" -gt 0 ]; then
    warn "ao doctor: ${warns} warnings"
  else
    pass "ao doctor: all checks passed"
  fi
}

check_namespace_alignment() {
  log "--- Namespace alignment ---"
  local config_path="$1"
  local config_dir
  config_dir="$(dirname "$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$config_path" 2>/dev/null || echo "$config_path")")"

  # Find lifecycle-worker PIDs with their project names
  local mismatched=0
  local checked=0
  while IFS= read -r line; do
    local pid project cwd
    pid=$(echo "$line" | awk '{print $2}')
    # Extract project name (last argument)
    project=$(echo "$line" | grep -oE 'lifecycle-worker [a-zA-Z0-9_-]+' | awk '{print $2}')
    cwd=$(lsof -p "$pid" 2>/dev/null | awk '/cwd/{print $NF}')
    if [ -z "$cwd" ] || [ -z "$project" ]; then
      continue
    fi
    checked=$((checked + 1))
    if [ "$cwd" != "$config_dir" ]; then
      fail "Namespace mismatch: $project (PID $pid) CWD=$cwd expected=$config_dir"
      mismatched=1
    fi
  done < <(ps aux | grep "[n]ode.*lifecycle-worker" | grep -v grep)

  if [ "$checked" -eq 0 ]; then
    warn "No lifecycle-worker processes found"
  elif [ "$mismatched" -eq 0 ]; then
    pass "All $checked lifecycle-workers in correct namespace ($config_dir)"
  fi
}

check_rogue_configs() {
  log "--- Rogue config scan ---"
  local config_path="$1"
  local canonical
  canonical="$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$config_path" 2>/dev/null || echo "$config_path")"

  # Check known dangerous locations
  local rogue_found=0
  for suspect in "$HOME/.agent-orchestrator/agent-orchestrator.yaml" \
                 "$HOME/.agent-orchestrator/agent-orchestrator.yml"; do
    if [ -f "$suspect" ]; then
      local resolved
      resolved="$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$suspect" 2>/dev/null || echo "$suspect")"
      if [ "$resolved" != "$canonical" ]; then
        fail "Rogue config at $suspect (resolves to $resolved, canonical is $canonical)"
        rogue_found=1
      fi
    fi
  done

  if [ "$rogue_found" -eq 0 ]; then
    pass "No rogue configs in data directory"
  fi
}

check_lifecycle_workers() {
  log "--- Lifecycle-worker health ---"
  local count
  count=$(ps aux | grep "[n]ode.*lifecycle-worker" | wc -l | tr -d ' ')

  if [ "$count" -eq 0 ]; then
    fail "No lifecycle-worker processes running"
    return
  fi

  # Count configured projects to set threshold
  local config_path_for_count
  config_path_for_count=$(resolve_config) || true
  local project_count=8  # default
  if [ -n "$config_path_for_count" ]; then
    local raw_count
    raw_count=$(grep -cE '^[[:space:]]+[a-zA-Z0-9_-]+:$' "$config_path_for_count" 2>/dev/null) || raw_count=0
    # Validate: grep -c can emit "0\n8" when it exits non-zero (output + fallback)
    if [[ "$raw_count" =~ ^[0-9]+$ ]]; then
      project_count="$raw_count"
    fi
    # Minimum reasonable threshold
    [ "$project_count" -lt 3 ] && project_count=3
  fi
  local max_workers=$((project_count + 2))  # small buffer for restarts

  if [ "$count" -gt "$max_workers" ]; then
    warn "Too many lifecycle-workers: $count (expected <=$max_workers for $project_count projects)"
  else
    pass "Lifecycle-workers running: $count"
  fi

  # List them
  ps aux | grep "[n]ode.*lifecycle-worker" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}' | while read -r line; do
    log "  worker: $line"
  done
}

check_rate_limits() {
  log "--- GitHub rate limits ---"
  local limits
  limits=$(gh api rate_limit --jq '.resources | {core: .core.remaining, graphql: .graphql.remaining}' 2>/dev/null) || {
    warn "Could not fetch rate limits (gh api failed)"
    return
  }

  local core graphql
  core=$(echo "$limits" | python3 -c "import sys,json; print(json.load(sys.stdin)['core'])" 2>/dev/null || echo "0")
  graphql=$(echo "$limits" | python3 -c "import sys,json; print(json.load(sys.stdin)['graphql'])" 2>/dev/null || echo "0")

  if [ "$core" -lt "$AO_DOCTOR_RATE_LIMIT_WARN" ]; then
    warn "GitHub core rate limit low: $core remaining (threshold: $AO_DOCTOR_RATE_LIMIT_WARN)"
  fi
  if [ "$graphql" -lt 200 ]; then
    warn "GitHub GraphQL rate limit low: $graphql remaining"
  fi
  if [ "$core" -ge "$AO_DOCTOR_RATE_LIMIT_WARN" ] && [ "$graphql" -ge 200 ]; then
    pass "Rate limits OK (core=$core, graphql=$graphql)"
  fi
}

check_session_sprawl() {
  log "--- Session sprawl ---"
  local sessions
  sessions=$(tmux list-sessions 2>/dev/null | grep -E "ao-[0-9]|jc-[0-9]" | cut -d: -f1) || true

  if [ -z "$sessions" ]; then
    pass "No active worker sessions"
    return
  fi

  # Map sessions to repo#PR keys to avoid cross-repo collisions
  local -A pr_sessions
  for s in $sessions; do
    local pr repo_hint key
    pr=$(tmux capture-pane -t "$s" -p -S -15 2>/dev/null | grep -oE "PR: #[0-9]+" | head -1 | grep -oE "[0-9]+" || echo "")
    repo_hint=$(tmux capture-pane -t "$s" -p -S -15 2>/dev/null | grep -oE "github.com/[^/]+/[^/]+" | head -1 | sed 's|github.com/||' || echo "")
    if [ -n "$pr" ] && [ -n "$repo_hint" ]; then
      key="${repo_hint}#${pr}"
      pr_sessions[$key]="${pr_sessions[$key]:-} $s"
    fi
  done

  local sprawl_found=0
  for key in "${!pr_sessions[@]}"; do
    local count
    count=$(echo "${pr_sessions[$key]}" | wc -w | tr -d ' ')
    if [ "$count" -gt "$AO_DOCTOR_MAX_SESSIONS_PER_PR" ]; then
      warn "Session sprawl: $key has $count sessions (max $AO_DOCTOR_MAX_SESSIONS_PER_PR):${pr_sessions[$key]}"
      sprawl_found=1
    fi
  done

  local total
  total=$(echo "$sessions" | wc -l | tr -d ' ')
  if [ "$sprawl_found" -eq 0 ]; then
    pass "No session sprawl ($total sessions, all PRs within limits)"
  fi
}

check_zombie_sessions() {
  log "--- Zombie sessions (merged/closed PRs) ---"
  local sessions
  sessions=$(tmux list-sessions 2>/dev/null | grep -E "ao-[0-9]|jc-[0-9]" | cut -d: -f1) || true

  if [ -z "$sessions" ]; then
    return
  fi

  local zombie_count=0
  for s in $sessions; do
    local pr_num repo_hint
    pr_num=$(tmux capture-pane -t "$s" -p -S -15 2>/dev/null | grep -oE "PR: #[0-9]+" | head -1 | grep -oE "[0-9]+" || echo "")
    repo_hint=$(tmux capture-pane -t "$s" -p -S -15 2>/dev/null | grep -oE "github.com/[^/]+/[^/]+" | head -1 | sed 's|github.com/||' || echo "")

    if [ -z "$pr_num" ] || [ -z "$repo_hint" ]; then
      continue
    fi

    local state
    state=$(gh pr view "$pr_num" --repo "$repo_hint" --json state --jq .state 2>/dev/null || echo "UNKNOWN")
    if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
      warn "Zombie session $s working on $state PR #$pr_num ($repo_hint)"
      zombie_count=$((zombie_count + 1))
    fi
  done

  if [ "$zombie_count" -eq 0 ]; then
    pass "No zombie sessions (all sessions on open PRs)"
  fi
}

check_cr_gaps() {
  log "--- CHANGES_REQUESTED coverage ---"
  local config_path="$1"
  local repos
  repos=$(detect_repos "$config_path")

  if [ -z "$repos" ]; then
    warn "No repos detected in config and AO_DOCTOR_REPO not set — cannot check CR gaps"
    return
  fi

  # Get active session→PR mapping (keyed by repo#pr to avoid cross-repo collisions)
  local -A session_prs
  local sessions
  sessions=$(tmux list-sessions 2>/dev/null | grep -E "ao-[0-9]|jc-[0-9]" | cut -d: -f1) || true
  for s in $sessions; do
    local pr repo_hint key
    pr=$(tmux capture-pane -t "$s" -p -S -15 2>/dev/null | grep -oE "PR: #[0-9]+" | head -1 | grep -oE "[0-9]+" || echo "")
    repo_hint=$(tmux capture-pane -t "$s" -p -S -15 2>/dev/null | grep -oE "github.com/[^/]+/[^/]+" | head -1 | sed 's|github.com/||' || echo "")
    if [ -n "$pr" ] && [ -n "$repo_hint" ]; then
      key="${repo_hint}#${pr}"
      session_prs[$key]="$s"
    fi
  done

  local gap_count=0
  for repo in $repos; do
    local cr_prs
    cr_prs=$(gh pr list --repo "$repo" --state open --json number,reviewDecision --jq '.[] | select(.reviewDecision == "CHANGES_REQUESTED") | .number' 2>/dev/null) || continue

    for pr_num in $cr_prs; do
      local key="${repo}#${pr_num}"
      if [ -z "${session_prs[$key]:-}" ]; then
        warn "CR gap: PR #$pr_num ($repo) has CHANGES_REQUESTED but no active session"
        gap_count=$((gap_count + 1))
      fi
    done
  done

  if [ "$gap_count" -eq 0 ]; then
    pass "All CHANGES_REQUESTED PRs have active sessions"
  fi
}

check_stray_worktrees() {
  log "--- Stray worktrees ---"
  local config_path="$1"
  local stray
  stray=$(git -C "$(dirname "$config_path")" worktree list 2>/dev/null | grep -v "$(dirname "$config_path") " | grep -v "/.worktrees/" || true)

  if [ -z "$stray" ]; then
    pass "No stray worktrees"
  else
    local count
    count=$(echo "$stray" | wc -l | tr -d ' ')
    warn "Stray worktrees: $count found outside expected dirs"
  fi
}

# Returns age in hours as a float, or -1 if createdAt is missing/unparseable.
_pr_age_hours() {
  local created_at="$1"
  if [ -z "$created_at" ]; then
    echo "-1"
    return
  fi
  # created_at format: "2026-03-27T12:00:00Z" — use python for reliable subtraction
  python3 -c "
import sys, datetime
try:
    created = datetime.datetime.fromisoformat('$created_at'.replace('Z','+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    age = (now - created).total_seconds() / 3600.0
    print(f'{age:.1f}')
except Exception:
    print('-1')
" 2>/dev/null || echo "-1"
}

check_pr_age() {
  # bd-ara.stale: enforce PR age visibility + stale flag + missing-age guardrail
  log "--- PR age tracking ---"
  local config_path="$1"
  local repos
  repos=$(detect_repos "$config_path")

  if [ -z "$repos" ]; then
    warn "No repos detected — PR age check skipped"
    return
  fi

  local missing_age_count=0
  local fresh_count=0

  REPORT_LINES+=("--- PR Age Summary ---")

  for repo in $repos; do
    local prs_json
    prs_json=$(gh pr list --repo "$repo" --state open --limit 100 \
      --json number,title,headRefName,createdAt,updatedAt \
      2>/dev/null) || continue

    while IFS= read -r pr_line; do
      [ -z "$pr_line" ] && continue
      local pr_num branch created updated
      pr_num=$(echo "$pr_line" | jq -r '.number')
      branch=$(echo "$pr_line" | jq -r '.headRefName')
      created=$(echo "$pr_line" | jq -r '.createdAt')
      updated=$(echo "$pr_line" | jq -r '.updatedAt')

      local age_hours
      age_hours=$(_pr_age_hours "$created")

      # Guardrail: fail if createdAt is missing (mechanical check — bd-ara.stale)
      if [ "$age_hours" = "-1" ] || [ -z "$created" ] || [ "$created" = "null" ]; then
        fail "PR #$pr_num ($repo): createdAt field missing — age guardrail triggered"
        missing_age_count=$((missing_age_count + 1))
        REPORT_LINES+=("  PR #$pr_num [$branch]: AGE_FIELD_MISSING")
        continue
      fi

      # Flag >3h as stale concern (configurable via AO_DOCTOR_STALE_HOURS)
      local stale_threshold="${AO_DOCTOR_STALE_HOURS:-3}"
      if python3 -c "import sys; sys.exit(0 if float('$age_hours') >= float('$stale_threshold') else 1)" 2>/dev/null; then
        warn "Stale PR: PR #$pr_num ($repo) age=${age_hours}h — uncovered or stalled (threshold=${stale_threshold}h)"
        REPORT_LINES+=("  PR #$pr_num [$branch]: age=${age_hours}h STALE")
        SLACK_STALE_PR_COUNT=$((SLACK_STALE_PR_COUNT + 1))
      else
        REPORT_LINES+=("  PR #$pr_num [$branch]: age=${age_hours}h")
        fresh_count=$((fresh_count + 1))
      fi
    done <<< "$(echo "$prs_json" | jq -c '.[]' 2>/dev/null || true)"
  done

  if [ "$missing_age_count" -gt 0 ]; then
    fail "$missing_age_count PR(s) missing createdAt — age guardrail is BLOCKING"
  elif [ "$SLACK_STALE_PR_COUNT" -eq 0 ]; then
    pass "All open PRs are fresh (<${AO_DOCTOR_STALE_HOURS:-3}h, fresh=$fresh_count)"
  fi
}

check_config_valid() {
  log "--- Config validation ---"
  local config_path="$1"
  # Run in subshell so errexit is always clean; never set -e here
  local rc=0
  AO_CONFIG_PATH="$config_path" ao doctor >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "Config validates OK ($config_path)"
  else
    fail "Config validation failed (exit $rc): $config_path"
  fi
}

# ---------------------------------------------------------------------------
# Phase 2 — LLM Inference (proposals only)
# ---------------------------------------------------------------------------

run_phase2() {
  if [ "$AO_DOCTOR_PHASE2_ENABLE" != "1" ]; then
    log "Phase 2 disabled (AO_DOCTOR_PHASE2_ENABLE=$AO_DOCTOR_PHASE2_ENABLE)"
    return
  fi

  if [ ${#PHASE1_FAILURES[@]} -eq 0 ]; then
    log "Phase 2 skipped — no unresolved issues"
    return
  fi

  log "--- Phase 2: LLM analysis ---"

  local failures_text=""
  for f in "${PHASE1_FAILURES[@]}"; do
    failures_text="${failures_text}
- ${f}"
  done

  # Gather context
  local lw_logs=""
  for logfile in ~/.agent-orchestrator/*/lifecycle-worker.log; do
    if [ -f "$logfile" ]; then
      lw_logs="${lw_logs}
=== $(basename "$(dirname "$logfile")") ===
$(tail -15 "$logfile" 2>/dev/null | grep -v "rate limit" | tail -10)"
    fi
  done

  local session_list=""
  session_list=$(tmux list-sessions 2>/dev/null | grep -E "ao-|jc-" | head -20 || echo "none")

  local prompt="You are the AO doctor-monitor Phase 2 analyst.
Phase 1 deterministic checks already ran. Only analyze unresolved issues.

Unresolved issues:
${failures_text}

Lifecycle-worker logs (recent):
${lw_logs}

Active tmux sessions:
${session_list}

Rules:
- PROPOSE fixes only. Do NOT execute any commands.
- Do NOT mutate config, kill processes, or merge PRs.
- Be concise. One paragraph per issue max.
- Output format: for each issue, state: issue, root_cause, proposed_fix, confidence (high/medium/low)
- confidence: high = deterministic fix, medium = likely fix, low = needs human review"

  local tmpfile
  tmpfile=$(mktemp /tmp/ao-doctor-phase2.XXXXXX)

  # Try claude -p first, fall back to codex
  if command -v claude >/dev/null 2>&1; then
    _run_with_timeout "$AO_DOCTOR_PHASE2_TIMEOUT" claude -p "$prompt" > "$tmpfile" 2>/dev/null
  elif command -v codex >/dev/null 2>&1; then
    _run_with_timeout "$AO_DOCTOR_PHASE2_TIMEOUT" codex exec "$prompt" > "$tmpfile" 2>/dev/null
  else
    log "Phase 2: no LLM CLI available (need claude or codex)"
    rm -f "$tmpfile"
    return
  fi

  local phase2_out
  phase2_out=$(cat "$tmpfile" 2>/dev/null)
  rm -f "$tmpfile"

  if [ -z "$phase2_out" ]; then
    log "Phase 2: LLM returned empty (timeout or error)"
    return
  fi

  REPORT_LINES+=("")
  REPORT_LINES+=("--- Phase 2 Proposals (LLM) ---")
  while IFS= read -r line; do
    REPORT_LINES+=("$line")
    log "Phase2: $line"
  done <<< "$phase2_out"
}

# ---------------------------------------------------------------------------
# Slack reporting
# ---------------------------------------------------------------------------

send_slack_report() {
  if [ -z "$AO_DOCTOR_SLACK_CHANNEL" ]; then
    return
  fi

  local severity_emoji="white_check_mark"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    severity_emoji="rotating_light"
  elif [ "$WARN_COUNT" -gt 0 ]; then
    severity_emoji="warning"
  fi

  local stale_info=""
  if [ "$SLACK_STALE_PR_COUNT" -gt 0 ]; then
    stale_info="
:hourglass: ${SLACK_STALE_PR_COUNT} stale PR(s) >${AO_DOCTOR_STALE_HOURS:-3}h"
  fi

  local header=":${severity_emoji}: *AO Doctor Monitor* — $(ts)
Phase 1: $PASS_COUNT PASS, $WARN_COUNT WARN, $FAIL_COUNT FAIL${stale_info}"

  local body=""
  for line in "${REPORT_LINES[@]}"; do
    case "$line" in
      FAIL*) body="${body}
:x: ${line}" ;;
      WARN*) body="${body}
:warning: ${line}" ;;
      PASS*) ;; # Skip passes in Slack for brevity
      ---*) body="${body}
${line}" ;;
      *) [ -n "$line" ] && body="${body}
${line}" ;;
    esac
  done

  local message="${header}${body}"

  # Try MCP Slack tool via curl to openclaw gateway, fall back to webhook
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    local payload_file
    payload_file=$(mktemp /tmp/slack-webhook-payload.XXXXXX)
    python3 -c "
import json, sys
print(json.dumps({'text': sys.argv[1], 'channel': sys.argv[2]}))
" "$message" "$AO_DOCTOR_SLACK_CHANNEL" > "$payload_file" 2>/dev/null
    curl -s -X POST -H 'Content-type: application/json' -d "@$payload_file" "$SLACK_WEBHOOK_URL" > /dev/null 2>&1 && {
      log "Slack report sent to $AO_DOCTOR_SLACK_CHANNEL"
      rm -f "$payload_file"
      return
    }
    rm -f "$payload_file"
  fi

  # Fall back: post via gh (uses user token, posts as user)
  if [ -n "${SLACK_USER_TOKEN:-}" ]; then
    local channel_id
    # Resolve channel name to ID if needed
    # Slack channel IDs are exactly 11 chars: C + 10 uppercase alphanum (e.g. C01234ABCDE)
    if [[ "${#AO_DOCTOR_SLACK_CHANNEL}" -eq 11 ]] && [[ "${AO_DOCTOR_SLACK_CHANNEL:0:1}" == "C" ]]; then
      channel_id="$AO_DOCTOR_SLACK_CHANNEL"
    else
      local list_auth_file _list_out _lookup_script
      list_auth_file=$(mktemp /tmp/slack-auth.XXXXXX)
      # curl config: each line is an option; value on the following line
      printf '%s\n' "-H" "Authorization: Bearer $SLACK_USER_TOKEN" > "$list_auth_file"
      _list_out=$(curl -s --config "$list_auth_file" \
             "https://slack.com/api/conversations.list?types=public_channel&limit=200")
      rm -f "$list_auth_file"
      if [ -n "$_list_out" ]; then
        _lookup_script=$(mktemp /tmp/slack-lookup.XXXXXX.py)
        cat > "$_lookup_script" <<'PYEOF2'
import sys, json
name = sys.argv[1].lstrip('#')
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(1)
if not data.get('ok', False):
    sys.exit(1)
for c in data.get('channels', []):
    if c.get('name') == name:
        print(c['id'])
        break
PYEOF2
        channel_id=$(printf '%s' "$_list_out" | python3 "$_lookup_script" "$AO_DOCTOR_SLACK_CHANNEL") || channel_id=""
        rm -f "$_lookup_script"
      fi
    fi

    if [ -n "$channel_id" ]; then
      local post_auth_file payload_file
      post_auth_file=$(mktemp /tmp/slack-auth.XXXXXX)
      printf '%s\n' "-H" "Authorization: Bearer $SLACK_USER_TOKEN" \
                    "-H" "Content-type: application/json" > "$post_auth_file"
      payload_file=$(mktemp /tmp/slack-payload.XXXXXX)
      python3 -c "import json,sys; print(json.dumps({'channel': sys.argv[1], 'text': sys.argv[2]}))" \
        "$channel_id" "$message" > "$payload_file" 2>/dev/null
      curl -s -X POST --config "$post_auth_file" \
        -d "@$payload_file" \
        "https://slack.com/api/chat.postMessage" > /dev/null 2>&1
      local post_rc=$?
      rm -f "$post_auth_file" "$payload_file"
      if [ "$post_rc" -eq 0 ]; then
        log "Slack report sent to $AO_DOCTOR_SLACK_CHANNEL via user token"
        return
      fi
    fi
  fi

  log "Slack report not sent (no SLACK_WEBHOOK_URL or SLACK_USER_TOKEN configured)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  log "========================================"
  log "AO Doctor Monitor start"
  log "========================================"

  # Resolve config
  local config_path
  config_path=$(resolve_config) || {
    fail "No agent-orchestrator.yaml found"
    send_slack_report
    return 1
  }
  log "Config: $config_path"

  # Phase 1: deterministic checks
  check_ao_doctor
  check_config_valid "$config_path"
  check_namespace_alignment "$config_path"
  check_rogue_configs "$config_path"
  check_lifecycle_workers
  check_rate_limits
  check_session_sprawl
  check_zombie_sessions
  check_cr_gaps "$config_path"
  check_stray_worktrees "$config_path"
  check_pr_age "$config_path"

  log ""
  log "Phase 1 results: $PASS_COUNT PASS, $WARN_COUNT WARN, $FAIL_COUNT FAIL"

  # Phase 2: LLM inference (only if issues found)
  run_phase2

  # Report
  send_slack_report

  log "AO Doctor Monitor complete"
  log "========================================"

  if [ "$FAIL_COUNT" -gt 0 ]; then
    return 1
  fi
  return 0
}

# Allow sourcing for testing
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
