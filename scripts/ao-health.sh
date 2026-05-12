#!/usr/bin/env bash
# ao-health.sh — Unified AO health check and remediation.
#
# Replaces: start-all.sh (launcher) + lw-watchdog.sh (monitor) + their plists.
# Called every 5 min by launchd ai.agento.health.
# Ensures lifecycle-workers are running for all configured projects.
# Idempotent — safe to run at any time.

set -uo pipefail

# Escape a string for use in an ERE (extended regular expression).
escape_ere() { printf '%s' "$1" | sed 's/[][().*^$+?{}|\\]/\\&/g'; }

# ── Config ──────────────────────────────────────────────────────────────────
REPO_ROOT="${AO_REPO_ROOT:-$HOME/project_agento/agent-orchestrator}"
LOCK_DIR="/tmp/ao-health.lock"
LOG_FILE="${AO_LOG_DIR:-$HOME/.openclaw/logs}/ao-health.log"
STALE_LOCK_SECS=600  # 10 minutes

# ── Lock (mkdir-based, auto-reap stale) ──────────────────────────────────────
if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
else
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ))
    if [ "$lock_age" -lt "$STALE_LOCK_SECS" ]; then
        exit 0
    fi
    rmdir "$LOCK_DIR" 2>/dev/null || exit 0
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
    trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
fi

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*" >> "$LOG_FILE"; }

# ── Source libs ─────────────────────────────────────────────────────────────
source "$REPO_ROOT/scripts/lib/ao-config-topology.sh" 2>/dev/null || {
    log "FATAL: cannot source ao-config-topology.sh"; exit 1
}

# ── Discover projects ────────────────────────────────────────────────────────
CONFIG_PATH=$(ao_find_config_path) || { log "FATAL: no config found"; exit 1; }

PROJECTS=$(python3 -c "
import yaml, sys
c = yaml.safe_load(open('$CONFIG_PATH')) or {}
ps = c.get('projects', {})
if isinstance(ps, dict):
    print(' '.join(ps.keys()))
" 2>/dev/null) || { log "FATAL: config parse failed"; exit 1; }

if [ -z "$PROJECTS" ]; then
    log "WARN: no projects found"; exit 0
fi

log "START projects=$PROJECTS"

# ── Main repo branch invariant ───────────────────────────────────────────────
MAIN_REPO="${AO_MAIN_REPO:-$REPO_ROOT}"
BRANCH=$(git -C "$MAIN_REPO" branch --show-current 2>/dev/null) || true
if [ "$BRANCH" != "main" ]; then
    git -C "$MAIN_REPO" rebase --abort 2>/dev/null || true
    git -C "$MAIN_REPO" merge --abort 2>/dev/null || true
    git -C "$MAIN_REPO" checkout main 2>/dev/null || {
        log "FATAL: cannot checkout main"; exit 1
    }
    git -C "$MAIN_REPO" pull --ff-only 2>/dev/null || true
fi

# ── Ensure lifecycle-worker for each project ─────────────────────────────────
FAILURES=0
STARTED=0

for project in $PROJECTS; do
    escaped_project="$(escape_ere "$project")"
    if pgrep -f "lifecycle-worker[[:space:]]${escaped_project}([[:space:]]|$)" > /dev/null 2>&1; then
        continue
    fi

    log "START: $project worker missing, starting..."
    nohup ao lifecycle-worker "$project" >> "$LOG_FILE" 2>&1 &
    disown
    STARTED=$((STARTED + 1))
    sleep 2

    if pgrep -f "lifecycle-worker[[:space:]]${escaped_project}([[:space:]]|$)" > /dev/null 2>&1; then
        log "OK: $project worker started"
    else
        log "FAIL: $project worker failed to start"
        FAILURES=$((FAILURES + 1))
    fi
done

# ── Kill orphans (lifecycle-worker PIDs not matching any project) ─────────────
ALL_PIDS=$(pgrep -f "lifecycle-worker" 2>/dev/null) || true
KILLED=0

for pid in $ALL_PIDS; do
    CMD=$(ps -p "$pid" -o args= 2>/dev/null) || continue
    MATCHED=false
    for project in $PROJECTS; do
        escaped_project="$(escape_ere "$project")"
        if echo "$CMD" | grep -qE "lifecycle-worker[[:space:]]${escaped_project}([[:space:]]|$)"; then
            MATCHED=true
            break
        fi
    done
    if [ "$MATCHED" = "false" ]; then
        log "KILL: orphan PID $pid: $CMD"
        kill "$pid" 2>/dev/null || true
        KILLED=$((KILLED + 1))
    fi
done

# ── Re-bootstrap own launchd service if deregistered ─────────────────────────
SELF_LABEL="ai.agento.health"
SELF_PLIST="$HOME/Library/LaunchAgents/ai.agento.health.plist"
SELF_STATE=$(launchctl print "gui/$(id -u)/$SELF_LABEL" 2>&1) || true
if echo "$SELF_STATE" | grep -q "Could not find service"; then
    log "REBOOTSTRAP: $SELF_LABEL deregistered, re-bootstrapping..."
    launchctl bootstrap "gui/$(id -u)" "$SELF_PLIST" 2>/dev/null || true
fi

# ── Log rotation (keep last 500 lines if >1MB) ──────────────────────────────
if [ -f "$LOG_FILE" ]; then
    SIZE=$(stat -f %z "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1048576 ]; then
        tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
fi

log "DONE started=$STARTED killed=$KILLED failures=$FAILURES"
exit "$FAILURES"
