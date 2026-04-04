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

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"
}

# Keep log file under 1MB
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 1048576 ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

UID_NUM=$(id -u)

# Known lifecycle-worker services and their plists
declare -A SERVICES
SERVICES=(
  ["com.agentorchestrator.lifecycle-agent-orchestrator"]="$HOME/Library/LaunchAgents/com.agentorchestrator.lifecycle-agent-orchestrator.plist"
  ["com.agentorchestrator.lifecycle-claude-code"]="$HOME/Library/LaunchAgents/com.agentorchestrator.lifecycle-claude-code.plist"
  ["com.agentorchestrator.lifecycle-worldarchitect"]="$HOME/Library/LaunchAgents/com.agentorchestrator.lifecycle-worldarchitect.plist"
)

for SERVICE_ID in "${!SERVICES[@]}"; do
  PLIST="${SERVICES[$SERVICE_ID]}"

  # Skip if plist doesn't exist
  if [ ! -f "$PLIST" ]; then
    continue
  fi

  # Extract project name from service ID for process matching
  PROJECT=$(echo "$SERVICE_ID" | sed 's/com.agentorchestrator.lifecycle-//')

  # Check launchd state
  STATE=$(launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | grep "state =" | awk '{print $3}' || echo "not_found")

  if [ "$STATE" = "running" ]; then
    # Healthy — check for duplicate processes (orphans alongside launchd-managed)
    MANAGED_PID=$(launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | grep "pid =" | awk '{print $3}' || echo "")
    ALL_PIDS=$(pgrep -f "lifecycle-worker $PROJECT" 2>/dev/null || echo "")

    if [ -n "$MANAGED_PID" ] && [ -n "$ALL_PIDS" ]; then
      for pid in $ALL_PIDS; do
        if [ "$pid" != "$MANAGED_PID" ]; then
          log "ORPHAN_KILL: $SERVICE_ID — killing orphan PID $pid (managed=$MANAGED_PID)"
          kill "$pid" 2>/dev/null || true
        fi
      done
    fi
    continue
  fi

  # Service is not running — either deregistered or waiting to spawn
  if echo "$STATE" | grep -q "not_found"; then
    log "DEREGISTERED: $SERVICE_ID — re-bootstrapping from $PLIST"

    # Kill any orphan processes first
    ORPHAN_PIDS=$(pgrep -f "lifecycle-worker $PROJECT" 2>/dev/null || echo "")
    if [ -n "$ORPHAN_PIDS" ]; then
      log "ORPHAN_KILL: $SERVICE_ID — killing orphan PIDs: $ORPHAN_PIDS"
      for pid in $ORPHAN_PIDS; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 2
    fi

    # Re-bootstrap
    launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>&1 | while read -r line; do
      log "BOOTSTRAP: $SERVICE_ID — $line"
    done

    # Verify
    sleep 3
    NEW_STATE=$(launchctl print "gui/$UID_NUM/$SERVICE_ID" 2>&1 | grep "state =" | awk '{print $3}' || echo "unknown")
    log "VERIFY: $SERVICE_ID — state=$NEW_STATE after bootstrap"

  elif [ "$STATE" = "waiting" ] || echo "$STATE" | grep -q "spawn"; then
    log "PENDING: $SERVICE_ID — state=$STATE (launchd will handle)"
  else
    log "UNKNOWN: $SERVICE_ID — state=$STATE"
  fi
done
