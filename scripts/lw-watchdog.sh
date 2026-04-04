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
# Process name patterns for pgrep — lifecycle-all runs all projects
SERVICE_PGREP_PATTERNS=(
  "ao[[:space:]]+lifecycle-worker"
)

for i in "${!SERVICE_IDS[@]}"; do
  SERVICE_ID="${SERVICE_IDS[$i]}"
  PLIST="${SERVICE_PLISTS[$i]}"

  # Skip if plist doesn't exist
  if [ ! -f "$PLIST" ]; then
    continue
  fi

  # Use pre-defined pgrep pattern (includes 'ao' prefix for accurate matching)
  PGREP_PATTERN="${SERVICE_PGREP_PATTERNS[$i]}"

  # Check launchd state (subshell + || guards against pipefail killing the loop)
  STATE=$( (launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | grep "state =" | awk '{print $3}') 2>/dev/null) || STATE="not_found"

  if [ "$STATE" = "running" ]; then
    # lifecycle-all launches start-all.sh which spawns child workers — MANAGED_PID is the
    # wrapper, not the workers. Skip orphan sweep for wrapper services to avoid killing
    # healthy child processes that have different PIDs than the wrapper.
    if [ "$SERVICE_ID" = "ai.agento.lifecycle-all" ]; then
      continue
    fi

    # Healthy — check for duplicate processes (orphans alongside launchd-managed)
    MANAGED_PID=$( (launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | grep "pid =" | awk '{print $3}') 2>/dev/null) || MANAGED_PID=""
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

  # Service is not running — either deregistered or waiting to spawn
  if echo "$STATE" | grep -q "not_found"; then
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
    NEW_STATE=$( (launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | grep "state =" | awk '{print $3}') 2>/dev/null) || NEW_STATE="unknown"
    log "VERIFY: $SERVICE_ID — state=$NEW_STATE after bootstrap"

  elif [ "$STATE" = "waiting" ] || echo "$STATE" | grep -q "spawn"; then
    log "PENDING: $SERVICE_ID — state=$STATE (launchd will handle)"
  else
    log "UNKNOWN: $SERVICE_ID — state=$STATE"
  fi
done
