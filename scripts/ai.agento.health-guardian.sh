#!/usr/bin/env bash
# ai.agento.health-guardian.sh — Tier 2 watchdog-of-watchdogs
#
# Per the 2026-06-10 fragility audit, the fleet relies on a single Tier 1
# watchdog (ai.agento.health, 5-min cadence). If that plist is deregistered
# or its log goes stale, the fleet is invisible until an operator notices.
#
# This Tier 2 (60-min cadence) closes that gap by:
#   1. Verifying ai.agento.health is registered and "state = running".
#   2. Verifying the Tier 1 log is fresh (mtime within 15 min).
#   3. Re-bootstrapping the Tier 1 plist from the FROZEN copy in
#      agent-orchestrator/launchd/ai.agento.health.plist.template if missing.
#   4. Posting a Slack alert to $HEALTH_GUARDIAN_ALERT_CHANNEL on each
#      remediation (dedupe by fingerprint, 60-min window).
#
# Self-heal: if THIS plist is deregistered, a future Tier 3
# (com.ao-runner-watchdog) can re-create it from the frozen copy at
#   launchd/ai.agento.health-guardian.plist.template
#
# Reference: wiki/concepts/WatchdogOfWatchdogsArchitecture.md
#            wiki/concepts/AgentOrchestratorDoctorShV2.md

set -u

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]:-}")/.." && pwd)}"
TIER1_LABEL="ai.agento.health"
TIER1_FROZEN_PLIST="$REPO_ROOT/launchd/$TIER1_LABEL.plist.template"
TIER1_PLIST="$HOME/Library/LaunchAgents/$TIER1_LABEL.plist"
# Source-of-truth order: live (substituted) > frozen (template w/ @VAR@)
# If live plist exists, use it; if missing, fall back to template + setup-launchd.sh.
TIER1_LOG="$HOME/.openclaw/logs/ao-health.log"
# Channel resolution matches the umbrella pattern from PR #615
# (jleechanorg/jleechanclaw, lib/slack_thread_lib.sh): empty default > wrong
# default. The plist's HEALTH_GUARDIAN_ALERT_CHANNEL is the source of truth;
# HERMES_OPS_SLACK_CHANNEL is the cross-job fallback (also env-driven, no
# hardcoded channel here). If both are empty, the post fails soft and no
# channel bleed occurs.
HERMES_OPS_SLACK_CHANNEL="${HERMES_OPS_SLACK_CHANNEL:-}"
CHANNEL="${HEALTH_GUARDIAN_ALERT_CHANNEL:-${HERMES_OPS_SLACK_CHANNEL:-}}"
# post_slack refuses to post when CHANNEL is empty (token check still runs
# first; missing token logs "no SLACK token" and returns 1 — same as before).
STATE_DIR="$HOME/.openclaw/logs"
DEDUPE_FILE="$STATE_DIR/health-guardian-alerts.sha"
LOG_PREFIX="[ai.agento.health-guardian]"

mkdir -p "$STATE_DIR" "$(dirname "$TIER1_PLIST")"

log() { printf '%s %s\n' "$LOG_PREFIX" "$*" >&2; }

post_slack() {
  local text="$1"
  local token="${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${SLACK_USER_TOKEN:-}}"
  if [ -z "$token" ]; then
    log "no SLACK token; cannot post: $text"
    return 1
  fi
  if [ -z "$CHANNEL" ]; then
    # No channel resolved — matches the umbrella pattern from PR #615: a missing
    # env no longer silently bleeds into a wrong channel; it fails soft.
    log "no CHANNEL resolved; cannot post: $text"
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

# dedup split into a pure check + a separate record step so the fingerprint is
# only written AFTER a successful post. The old combined `dedup_should_send`
# wrote the fingerprint before post_slack ran, so a failed post (e.g. empty
# channel, token missing, network error) would still suppress the next real
# alert within the dedupe window — P2 review comment from
# chatgpt-codex-connector on PR #687.
dedup_already_sent() {
  local fingerprint="$1"
  local now
  now=$(date +%s)
  if [ -f "$DEDUPE_FILE" ]; then
    local last_hash last_ts
    last_hash=$(awk '{print $1}' "$DEDUPE_FILE" 2>/dev/null || echo "")
    last_ts=$(awk '{print $2}' "$DEDUPE_FILE" 2>/dev/null || echo 0)
    if [ "$last_hash" = "$fingerprint" ] && [ $((now - last_ts)) -lt 3600 ]; then
      return 0
    fi
  fi
  return 1
}

dedup_record() {
  local fingerprint="$1"
  printf '%s %s\n' "$fingerprint" "$(date +%s)" > "$DEDUPE_FILE"
}

alert_count=0
alert_lines=""

# --- Check 1: Tier 1 freshness (log mtime is more reliable than launchd state
# for interval-based jobs; "state = running" is only true WHILE the script is
# actively executing, not between intervals).
TIER1_FRESH=0
TIER1_REGISTERED=0
# A registered plist shows "type = LaunchAgent" in launchctl print output;
# the state field cycles between "running" (during execution) and "not running"
# (between intervals) for interval-based jobs, so we can't use state alone.
if launchctl print "gui/$(id -u)/$TIER1_LABEL" 2>/dev/null | grep -q "type = LaunchAgent"; then
  TIER1_REGISTERED=1
fi
# Self-dep log: confirm the frozen template is reachable so the re-bootstrap
# path can find it. This is informational only — TIER1_FROZEN_PLIST may be
# absent during early bootstrap (e.g. fresh clone) and the live-plist path
# will still work. See `wiki/concepts/WatchdogOfWatchdogsArchitecture.md`.
if [ -f "$TIER1_FROZEN_PLIST" ]; then
  log "frozen template available at $TIER1_FROZEN_PLIST (Tier 1 re-bootstrap source of truth)"
else
  log "frozen template NOT found at $TIER1_FROZEN_PLIST — Tier 1 re-bootstrap will fall back to live plist only"
fi
if [ -f "$TIER1_LOG" ]; then
  log_mtime=$(stat -f %m "$TIER1_LOG" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - log_mtime))
  # Fresh if the log was written within 2× the StartInterval (10 min for Tier 1).
  if [ "$age" -lt 600 ]; then
    TIER1_FRESH=1
  fi
fi

if [ "$TIER1_REGISTERED" -eq 0 ]; then
  alert_count=$((alert_count + 1))
  alert_lines="${alert_lines}\n:rotating_light: $TIER1_LABEL plist not registered"
  # Prefer the live (substituted) plist; fall back to substituting the
  # frozen template and bootstrapping the result (true auto-rebootstrap).
  if [ -f "$TIER1_PLIST" ]; then
    log "bootstrapping $TIER1_LABEL from live plist"
    launchctl bootstrap "gui/$(id -u)" "$TIER1_PLIST" 2>/dev/null \
      && log "bootstrap attempted for $TIER1_LABEL" \
      || log "bootstrap FAILED for $TIER1_LABEL (live plist present but rejected)"
  elif [ -f "$TIER1_FROZEN_PLIST" ]; then
    # Frozen template contains @REPO_ROOT@, @HOME@, @PATH@ placeholders.
    # Substitute them in place to ~/Library/LaunchAgents and bootstrap.
    log "frozen template found at $TIER1_FROZEN_PLIST — substituting placeholders"
    tmp_plist=$(mktemp "/tmp/health-guardian-XXXXXX.plist")
    if sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" \
           -e "s|@HOME@|$HOME|g" \
           -e "s|@PATH@|${PATH:-/usr/local/bin:/usr/bin:/bin}|g" \
           "$TIER1_FROZEN_PLIST" > "$tmp_plist" 2>/dev/null; then
      mv -f "$tmp_plist" "$TIER1_PLIST"
      chmod 600 "$TIER1_PLIST"
      log "substituted plist written to $TIER1_PLIST"
      launchctl bootstrap "gui/$(id -u)" "$TIER1_PLIST" 2>/dev/null \
        && log "bootstrap from frozen template attempted for $TIER1_LABEL" \
        || log "bootstrap FAILED for $TIER1_LABEL (frozen template substituted but rejected)"
    else
      rm -f "$tmp_plist"
      log "sed substitution FAILED for $TIER1_FROZEN_PLIST"
    fi
  else
    log "no plist found at $TIER1_PLIST or $TIER1_FROZEN_PLIST"
  fi
elif [ "$TIER1_FRESH" -eq 0 ]; then
  alert_count=$((alert_count + 1))
  alert_lines="${alert_lines}\n:warning: $TIER1_LABEL log stale (no recent run)"
  launchctl kickstart -kp "gui/$(id -u)/$TIER1_LABEL" 2>/dev/null \
    && log "kickstart attempted for $TIER1_LABEL" \
    || log "kickstart FAILED for $TIER1_LABEL"
fi

# --- Check 2: hermes-watchdog also alive (cross-watchdog) ---
# Use log freshness as the source of truth, not launchd state.
HERMES_WD_LOG="/tmp/hermes-watchdog.log"
HERMES_FRESH=0
if [ -f "$HERMES_WD_LOG" ]; then
  hlog_mtime=$(stat -f %m "$HERMES_WD_LOG" 2>/dev/null || echo 0)
  now=$(date +%s)
  hage=$((now - hlog_mtime))
  if [ "$hage" -lt 600 ]; then
    HERMES_FRESH=1
  fi
fi
if [ "$HERMES_FRESH" -eq 0 ]; then
  alert_count=$((alert_count + 1))
  alert_lines="${alert_lines}\n:warning: ai.hermes-watchdog log stale or missing"
  launchctl kickstart -kp "gui/$(id -u)/ai.hermes-watchdog" 2>/dev/null \
    && log "kickstart attempted for ai.hermes-watchdog" \
    || log "kickstart FAILED for ai.hermes-watchdog"
fi

# --- Check 4: lifecycle-worker process count sanity (catches "running but broken") ---
WORKER_COUNT=$(pgrep -f "lifecycle-worker" 2>/dev/null | wc -l | tr -d ' ')
if [ "${WORKER_COUNT:-0}" -gt 30 ]; then
  alert_count=$((alert_count + 1))
  alert_lines="${alert_lines}\n:warning: unusually high lifecycle-worker count: $WORKER_COUNT (>30 threshold)"
fi

if [ "$alert_count" -gt 0 ]; then
  body=":rotating_light: ai.agento.health-guardian alerts ($alert_count):${alert_lines}"
  fingerprint=$(printf '%s' "$body" | shasum -a 256 | awk '{print $1}')
  if dedup_already_sent "$fingerprint"; then
    log "alert dedup-suppressed (same fingerprint within 60 min)"
  elif post_slack "$body"; then
    dedup_record "$fingerprint"
    log "alert posted: $alert_count issue(s)"
  else
    log "alert not delivered: $body"
  fi
else
  log "all checks green (workers=$WORKER_COUNT)"
fi
