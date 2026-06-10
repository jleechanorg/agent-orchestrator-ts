#!/usr/bin/env bash
# hermes-watchdog.sh — restored 2026-06-10
#
# Originally referenced by ai.hermes-watchdog.plist (StartInterval=300, ~5 min)
# but the script was missing. The plist has been failing with
#   "/bin/bash: /Users/jleechan/.hermes/scripts/hermes-watchdog.sh: No such file or directory"
# for 158+ runs since May 2026.
#
# Behavior (per fragility audit 2026-06-10):
#   1. Liveness check of the prod Hermes gateway (ai.hermes.gateway).
#   2. Liveness check of the AO health watchdog (ai.agento.health).
#   3. Disk space + tmux pane sanity.
#   4. Post a single Slack message to $HERMES_WATCHDOG_ALERT_CHANNEL on
#      any FAIL — dedupe by hashing the alert text so we don't flood
#      (suppress repeats within 30 minutes).
#
# Re-bootstrap pattern: ai.agento.health-guardian (proposed Tier 2) can
# re-create this file from the frozen copy in
#   agent-orchestrator/scripts/hermes-watchdog.sh
# if it is ever deleted again.

set -u

CHANNEL="${HERMES_WATCHDOG_ALERT_CHANNEL:-C09GRLXF9GR}"
STATE_DIR="${HERMES_HOME:-$HOME/.hermes_prod}/.watchdog-state"
mkdir -p "$STATE_DIR"
DEDUPE_FILE="$STATE_DIR/last_alert.sha"
LOG_PREFIX="[hermes-watchdog]"

log() { printf '%s %s\n' "$LOG_PREFIX" "$*" >&2; }

post_slack() {
  local text="$1"
  local token="${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${SLACK_USER_TOKEN:-}}"
  if [ -z "$token" ]; then
    log "no SLACK token; cannot post: $text"
    return 1
  fi
  local payload
  if command -v jq >/dev/null 2>&1; then
    payload=$(jq -n --arg channel "$CHANNEL" --arg text "$text" '{"channel":$channel,"text":$text}')
  elif command -v python3 >/dev/null 2>&1; then
    payload=$(CHANNEL="$CHANNEL" TEXT="$text" python3 -c '
import json, os
print(json.dumps({"channel": os.environ["CHANNEL"], "text": os.environ["TEXT"]}))
' 2>/dev/null)
  else
    local escaped_text
    escaped_text=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/' | tr -d '\n' | sed 's/\\n$//')
    payload=$(printf '{"channel":"%s","text":"%s"}' "$CHANNEL" "$escaped_text")
  fi

  local response
  response=$(curl -sS -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$payload" \
    https://slack.com/api/chat.postMessage 2>&1)
  if [ $? -ne 0 ] || ! echo "$response" | grep -q '"ok":true'; then
    log "slack post failed for: $text (response: $response)"
    return 1
  fi
}

dedup_should_send() {
  local fingerprint="$1"
  local now
  now=$(date +%s)
  if [ -f "$DEDUPE_FILE" ]; then
    local last_hash last_ts
    last_hash=$(awk '{print $1}' "$DEDUPE_FILE" 2>/dev/null || echo "")
    last_ts=$(awk '{print $2}' "$DEDUPE_FILE" 2>/dev/null || echo 0)
    if [ "$last_hash" = "$fingerprint" ] && [ $((now - last_ts)) -lt 1800 ]; then
      return 1
    fi
  fi
  printf '%s %s\n' "$fingerprint" "$now" > "$DEDUPE_FILE"
  return 0
}

fail_count=0
alert_lines=""

# For interval-based launchd jobs (StartInterval=N), the job is "not running"
# between executions. Using `state = running` fires on most passes and spams
# Slack. Use log mtime as the canonical "did the watchdog run recently?"
# signal: a watchdog is healthy iff its log was updated within ~2x its
# StartInterval (5 min => 600s for ai.agento.health; gateway is KeepAlive
# so 300s is plenty).
is_interval_job_fresh() {
  local label="${1:-}" log_path="${2:-}" max_age="${3:-}"
  if [ -z "$label" ]; then
    log "is_interval_job_fresh: missing label parameter"
    return 1
  fi
  if [ -z "$log_path" ]; then
    log "is_interval_job_fresh: missing log_path parameter"
    return 1
  fi
  # 1. Must be registered as a LaunchAgent
  if ! launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -q "type = LaunchAgent"; then
    return 1
  fi
  # 2. Log mtime must be within max_age seconds
  if [ ! -f "$log_path" ]; then
    return 1
  fi
  local log_mtime now age
  log_mtime=$(stat -f %m "$log_path" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - log_mtime))
  if [ "$age" -lt "$max_age" ]; then
    return 0
  fi
  return 1
}

check_gateway() {
  # ai.hermes.gateway is KeepAlive; treat as unhealthy if log stale.
  if ! is_interval_job_fresh "ai.hermes.gateway" "$HOME/.hermes_prod/logs/gateway.log" 300; then
    fail_count=$((fail_count + 1))
    alert_lines="${alert_lines}\n:rotating_light: ai.hermes.gateway plist not running or log stale"
  fi
}

check_ao_health() {
  # ai.agento.health is StartInterval=300 (5 min); 2x = 600s window.
  if ! is_interval_job_fresh "ai.agento.health" "$HOME/.openclaw/logs/ao-health.log" 600; then
    fail_count=$((fail_count + 1))
    alert_lines="${alert_lines}\n:warning: ai.agento.health watchdog plist stale (no recent run)"
  fi
}

check_disk() {
  local free_pct
  free_pct=$(df -P "$HOME" | awk 'NR==2 {gsub("%","",$5); print 100-$5}')
  if [ "${free_pct:-0}" -lt 5 ]; then
    fail_count=$((fail_count + 1))
    alert_lines="${alert_lines}\n:warning: $HOME disk space critically low: ${free_pct}% free"
  fi
}

check_tmux() {
  # Bare liveness: server exists? If down, that's not a slack event (recoverable).
  if ! command -v tmux >/dev/null 2>&1; then
    return 0
  fi
  if ! tmux list-sessions >/dev/null 2>&1; then
    return 0
  fi
  # If a session exists, ensure the count of running panes is > 0 (catches the
  # "tmux alive but all panes dead" silent-failure path).
  local pane_count
  pane_count=$(tmux list-panes -a -F '#{pane_pid}' 2>/dev/null | wc -l | tr -d ' ')
  if [ "${pane_count:-0}" -eq 0 ]; then
    fail_count=$((fail_count + 1))
    alert_lines="${alert_lines}\n:warning: tmux server up but 0 live panes"
  fi
}

check_gateway
check_ao_health
check_disk
check_tmux

if [ "$fail_count" -gt 0 ]; then
  body=":rotating_light: hermes-watchdog alerts ($fail_count):${alert_lines}"
  fingerprint=$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')
  if dedup_should_send "$fingerprint"; then
    post_slack "$body" || log "alert not delivered: $body"
    log "alert posted: $fail_count issue(s)"
  else
    log "alert dedup-suppressed (same fingerprint within 30 min)"
  fi
else
  log "all checks green"
fi
