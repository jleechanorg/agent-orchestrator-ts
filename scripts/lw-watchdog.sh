#!/bin/bash
# lw-watchdog.sh — Self-healing watchdog for lifecycle-worker launchd services
#
# Problem: lifecycle-worker exits rapidly (e.g., claim_failed loop) → launchd
# thrashing protection deregisters the service → no auto-restart → orphan
# manual processes accumulate → zero-touch rate drops to 0%.
#
# Solution: This script runs every 5 minutes via its own launchd plist.
# For each known lifecycle-worker service:
#   1. Check if launchd service is registered and running
#   2. If deregistered: kill orphan processes, re-bootstrap the plist
#   3. If registered but not running: launchd will handle restart (KeepAlive)
#   4. Log all actions for debugging
#
# Caller: com.agentorchestrator.lw-watchdog.plist (launchd, every 5 min)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/lib/launchd-service-state.sh"

LOG_DIR="$HOME/.openclaw/logs"
LOG_FILE="$LOG_DIR/lw-watchdog.log"
mkdir -p "$LOG_DIR"

# Lock to prevent overlapping watchdog instances (launchd may re-fire before we finish)
# Uses mkdir for atomic lock — works on macOS (no flock) and Linux
LOCKDIR="/tmp/lw-watchdog.lock"
LOCK_ACQUIRED=false
cleanup_lock() { if $LOCK_ACQUIRED; then rmdir "$LOCKDIR" 2>/dev/null || true; fi; }
trap cleanup_lock EXIT
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # Check for stale lock (older than 10 minutes = stuck previous run)
  if [ -d "$LOCKDIR" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCKDIR" 2>/dev/null || stat -c %Y "$LOCKDIR" 2>/dev/null || echo "0") ))
    if [ "$LOCK_AGE" -gt 600 ]; then
      rmdir "$LOCKDIR" 2>/dev/null || true
      mkdir "$LOCKDIR" 2>/dev/null || { exit 0; }
      LOCK_ACQUIRED=true
    else
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SKIP: another watchdog instance is running" >> "$LOG_FILE"
      exit 0
    fi
  fi
else
  LOCK_ACQUIRED=true
fi

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"
}

CONFIG_FILE="${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}"
CONFIG_PARSE_FAILED_SENTINEL="__CONFIG_PARSE_FAILED__"

list_configured_projects() {
  if [ ! -f "$CONFIG_FILE" ]; then
    return 0
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    log "WARN: python3 not available; unable to parse configured projects from $CONFIG_FILE"
    printf '%s\n' "$CONFIG_PARSE_FAILED_SENTINEL"
    return 0
  fi

  if ! CONFIG_FILE="$CONFIG_FILE" python3 -c '
import os
import yaml

with open(os.environ["CONFIG_FILE"]) as f:
    cfg = yaml.safe_load(f) or {}

for pid in cfg.get("projects", {}):
    print(pid)
' 2>/dev/null; then
    log "WARN: failed to parse configured projects from $CONFIG_FILE; continuing watchdog run"
    printf '%s\n' "$CONFIG_PARSE_FAILED_SENTINEL"
    return 0
  fi
}

list_missing_lifecycle_workers() {
  local configured_projects
  local project
  local missing=""

  configured_projects="$(list_configured_projects)"
  if [ "$configured_projects" = "$CONFIG_PARSE_FAILED_SENTINEL" ]; then
    printf '%s' "$CONFIG_PARSE_FAILED_SENTINEL"
    return 0
  fi

  while IFS= read -r project; do
    [ -n "$project" ] || continue
    if ! has_exact_lifecycle_worker_for_project "$project"; then
      if [ -n "$missing" ]; then
        missing="${missing} ${project}"
      else
        missing="$project"
      fi
    fi
  done <<EOF
$configured_projects
EOF

  printf '%s' "$missing"
}

has_exact_lifecycle_worker_for_project() {
  local project="$1"
  local process_line

  # Workers spawn as: nohup node ... lifecycle-worker <project>
  # pgrep -f matches the full command line; pattern must match the process args.
  while IFS= read -r process_line; do
    case "$process_line" in
      *lifecycle-worker[[:space:]]+${project}|*lifecycle-worker[[:space:]]+${project}[[:space:]]*) return 0 ;;
    esac
  done <<EOF
$(pgrep -lf "lifecycle-worker" 2>/dev/null || true)
EOF

  return 1
}

# Keep log file under 1MB
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 1048576 ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

UID_NUM=$(id -u)

# Known lifecycle-worker services and their plists (bash 3.2 compatible — no associative arrays)
# setup-launchd.sh removes legacy com.agentorchestrator.lifecycle-* plists and migrates to
# ai.agento.lifecycle-all. Only monitor services that setup actually installs.
SERVICE_IDS=(
  "ai.agento.lifecycle-all"
)
SERVICE_PLISTS=(
  "$HOME/Library/LaunchAgents/ai.agento.lifecycle-all.plist"
)
# Process name patterns for pgrep — lifecycle-all spawns workers via node, so match
# the "lifecycle-worker <project>" suffix. Workers are: nohup node ... lifecycle-worker <project>
SERVICE_PGREP_PATTERNS=(
  "lifecycle-worker"
)

for i in "${!SERVICE_IDS[@]}"; do
  SERVICE_ID="${SERVICE_IDS[$i]}"
  PLIST="${SERVICE_PLISTS[$i]}"

  # Skip if plist doesn't exist
  if [ ! -f "$PLIST" ]; then
    continue
  fi

  # Use pre-defined pgrep pattern (workers spawn via node, match on "lifecycle-worker")
  PGREP_PATTERN="${SERVICE_PGREP_PATTERNS[$i]}"

  # Parse the full launchctl state string. `state = not running` must stay intact;
  # tokenizing to the 3rd field misclassifies it as just `not`, which disables repair.
  STATE_OUTPUT="$(launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 || true)"
  STATE="$(extract_launchctl_state_from_output "$STATE_OUTPUT")"
  STATE_CLASS="$(classify_launchctl_state "$STATE")"

  if [ "$STATE_CLASS" = "running" ]; then
    # lifecycle-all launches start-all.sh which spawns child workers — MANAGED_PID is the
    # wrapper, not the workers. Skip orphan sweep for wrapper services to avoid killing
    # healthy child processes that have different PIDs than the wrapper.
    if [ "$SERVICE_ID" = "ai.agento.lifecycle-all" ]; then
      continue
    fi

    # Healthy — check for duplicate processes (orphans alongside launchd-managed)
    MANAGED_PID=$( (launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | sed -n 's/^[[:space:]]*pid = //p' | head -1) 2>/dev/null) || MANAGED_PID=""
    ALL_PIDS=$(pgrep -f "$PGREP_PATTERN" 2>/dev/null) || ALL_PIDS=""

    if [ -n "$MANAGED_PID" ] && [ -n "$ALL_PIDS" ]; then
      for pid in $ALL_PIDS; do
        if [ "$pid" != "$MANAGED_PID" ]; then
          # Validate PID is actually a lifecycle-worker before killing
          PID_CMD=$(ps -p "$pid" -o args= 2>/dev/null || echo "")
          if echo "$PID_CMD" | grep -q "lifecycle-worker"; then
            log "ORPHAN_KILL: $SERVICE_ID — killing orphan PID $pid (managed=$MANAGED_PID, cmd=$PID_CMD)"
            kill "$pid" 2>/dev/null || true
          else
            log "ORPHAN_SKIP: $SERVICE_ID — PID $pid matched pgrep but is not lifecycle-worker (cmd=$PID_CMD)"
          fi
        fi
      done
    fi
    continue
  fi

  if [ "$SERVICE_ID" = "ai.agento.lifecycle-all" ] && [ "$STATE_CLASS" = "not_running" ]; then
    # Wrapper (start-all.sh) exits after forking workers — this is NORMAL.
    # Check if workers are actually running before deciding to kick.
    MISSING_WORKERS="$(list_missing_lifecycle_workers)"
    if [ "$MISSING_WORKERS" = "$CONFIG_PARSE_FAILED_SENTINEL" ]; then
      log "WARN: $SERVICE_ID — configured project list unavailable; skipping kickstart to avoid false restart loop"
      continue
    fi
    if [ -z "$MISSING_WORKERS" ]; then
      # All workers present — wrapper exited normally after forking. HEALTHY.
      log "HEALTHY_DORMANT: $SERVICE_ID — wrapper not running, all child lifecycle workers present"
      continue
    fi

    # Workers are missing — kick the service to respawn them.
    log "RESTART_NEEDED: $SERVICE_ID — missing lifecycle workers: $MISSING_WORKERS"
    KICKSTART_OUT="$(launchctl kickstart -k "gui/$UID_NUM/$SERVICE_ID" 2>&1 || true)"
    if [ -n "$KICKSTART_OUT" ]; then
      log "KICKSTART: $SERVICE_ID — $KICKSTART_OUT"
    fi

    # Wait up to 60s for workers to respawn (start-all.sh forks then exits).
    # Poll every 5s so a fast respawn doesn't waste time.
    WORKERS_CONFIRMED=""
    for retry in $(seq 1 12); do
      sleep 5
      STILL_MISSING="$(list_missing_lifecycle_workers)"
      if [ "$STILL_MISSING" = "$CONFIG_PARSE_FAILED_SENTINEL" ]; then
        log "VERIFY: $SERVICE_ID — config unavailable after kick, giving up"
        break
      fi
      if [ -z "$STILL_MISSING" ]; then
        WORKERS_CONFIRMED=1
        log "VERIFY: $SERVICE_ID — all workers present after ${retry}x5s"
        break
      fi
      log "RETRY: $SERVICE_ID — still missing: $STILL_MISSING (attempt ${retry}/12)"
    done
    if [ -z "$WORKERS_CONFIRMED" ]; then
      MISSING_AFTER="$(list_missing_lifecycle_workers)"
      if [ "$MISSING_AFTER" != "$CONFIG_PARSE_FAILED_SENTINEL" ] && [ -n "$MISSING_AFTER" ]; then
        log "WARN: $SERVICE_ID — workers still missing after 60s: $MISSING_AFTER"
      fi
    fi
    continue
  fi

  # Service is not running — either deregistered or waiting to spawn
  if [ "$STATE_CLASS" = "not_found" ]; then
    log "DEREGISTERED: $SERVICE_ID — re-bootstrapping from $PLIST"

    # Kill any orphan processes first (with validation)
    ORPHAN_PIDS=$(pgrep -f "$PGREP_PATTERN" 2>/dev/null) || ORPHAN_PIDS=""
    if [ -n "$ORPHAN_PIDS" ]; then
      log "ORPHAN_KILL: $SERVICE_ID — killing orphan PIDs: $ORPHAN_PIDS"
      for pid in $ORPHAN_PIDS; do
        PID_CMD=$(ps -p "$pid" -o args= 2>/dev/null || echo "")
        if echo "$PID_CMD" | grep -q "lifecycle-worker"; then
          log "ORPHAN_KILL: $SERVICE_ID — killing validated PID $pid (cmd=$PID_CMD)"
          kill "$pid" 2>/dev/null || true
        else
          log "ORPHAN_SKIP: $SERVICE_ID — PID $pid not lifecycle-worker (cmd=$PID_CMD)"
        fi
      done
      sleep 2
    fi

    # Re-bootstrap (|| true prevents set -e from aborting remaining services)
    BOOTSTRAP_OUT=$(launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>&1 || true)
    if [ -n "$BOOTSTRAP_OUT" ]; then
      log "BOOTSTRAP: $SERVICE_ID — $BOOTSTRAP_OUT"
    fi

    # Verify
    sleep 3
    NEW_STATE_OUTPUT="$(launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 || true)"
    NEW_STATE="$(extract_launchctl_state_from_output "$NEW_STATE_OUTPUT")"
    log "VERIFY: $SERVICE_ID — state=$NEW_STATE after bootstrap"

  elif [ "$STATE_CLASS" = "waiting" ] || [ "$STATE_CLASS" = "spawn_pending" ]; then
    log "PENDING: $SERVICE_ID — state=$STATE (launchd will handle)"
  else
    log "UNKNOWN: $SERVICE_ID — state=$STATE"
  fi
done
