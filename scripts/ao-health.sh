#!/usr/bin/env bash
# ao-health.sh — Unified AO health check and remediation.
#
# Replaces: start-all.sh (launcher) + lw-watchdog.sh (monitor) + their plists.
# Called every 5 min by launchd ai.agento.health.
# Ensures ao start <project> (in-process polling) is running for all configured projects.
# Idempotent — safe to run at any time.

set -uo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${AO_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
LOCK_DIR="/tmp/ao-health.lock"
LOG_FILE="${AO_LOG_DIR:-$HOME/.openclaw/logs}/ao-health.log"
STALE_LOCK_SECS=600  # 10 minutes

# Pure helpers (testable in isolation — see scripts/test-ao-health.sh).
# shellcheck source=./lib/ao-health-helpers.sh
source "$SCRIPT_DIR/lib/ao-health-helpers.sh" 2>/dev/null || {
    echo "FATAL: cannot source $SCRIPT_DIR/lib/ao-health-helpers.sh" >&2
    exit 1
}

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

# NOTE: Wafer endpoint canary probe (and WAFER_API_KEY pre-load) removed
# 2026-06-25 — we do not use the wafer provider, so the per-tick
# `WARN: wafer auth invalid/expired (HTTP 401)` log line was pure noise.
# If wafer is ever re-enabled, re-introduce probe_wafer_endpoint() here.

PROJECTS=$(python3 - "$CONFIG_PATH" <<'PYEOF' 2>/dev/null
import sys
yaml = __import__('yaml')
config_path = sys.argv[1]
c = yaml.safe_load(open(config_path)) or {}
ps = c.get('projects', {})
if isinstance(ps, dict):
    print(' '.join(ps.keys()))
PYEOF
) || { log "FATAL: config parse failed"; exit 1; }

if [ -z "$PROJECTS" ]; then
    log "WARN: no projects found"; exit 0
fi

log "START projects=$PROJECTS"

# ── Main repo branch invariant ───────────────────────────────────────────────
MAIN_REPO="${AO_MAIN_REPO:-$REPO_ROOT}"
BRANCH=$(git -C "$MAIN_REPO" branch --show-current 2>/dev/null) || true
if [ "$BRANCH" != "main" ]; then
    if [ "${AO_FORCE_MAIN:-}" != "true" ]; then
        log "WARN: MAIN_REPO=$MAIN_REPO not on main (was $BRANCH); skipping force-main (set AO_FORCE_MAIN=true to enable)"
    else
        log "WARN: MAIN_REPO=$MAIN_REPO not on main (was $BRANCH); forcing stable main (AO_FORCE_MAIN=true)"
        if git -C "$MAIN_REPO" rebase --abort 2>/dev/null; then
            log "WARN: aborted in-progress rebase in $MAIN_REPO"
        fi
        if git -C "$MAIN_REPO" merge --abort 2>/dev/null; then
            log "WARN: aborted in-progress merge in $MAIN_REPO"
        fi
        git -C "$MAIN_REPO" checkout main 2>/dev/null || {
            log "FATAL: cannot checkout main"; exit 1
        }
        log "INFO: checked out main in $MAIN_REPO"
        git -C "$MAIN_REPO" pull --ff-only 2>/dev/null || true
        log "INFO: git pull --ff-only completed in $MAIN_REPO"
    fi
fi

# ── Ensure ao start <project> (in-process polling) for each project ─────────
FAILURES=0
STARTED=0

# Resolve AO binary for launch and liveness-scoping together so both
# always agree on the same path.  AO_MATCH is used by command_matches_ao_binary
# to scope pgrep hits to *this* install; AO_LAUNCH is the actual command array.
# When AO_CLI_PATH points to a source-tree dist (e.g. packages/cli/dist/index.js),
# invoke it as "node $AO_CLI_PATH" so the source-tree's Zod schema is used,
# not the globally-installed npm binary which may have a stale/narrower enum.
# When AO_CLI_PATH is an executable binary or shell script, run it directly.
# Fall back to plain "ao" (from PATH) when AO_CLI_PATH is unset or missing.
# Uses an array to preserve paths with spaces through word-splitting.
if [ -n "${AO_CLI_PATH:-}" ] && [ -f "${AO_CLI_PATH}" ]; then
    if [ -x "${AO_CLI_PATH}" ]; then
        AO_LAUNCH=("${AO_CLI_PATH}")
    else
        AO_LAUNCH=(node "${AO_CLI_PATH}")
    fi
    AO_MATCH="${AO_CLI_PATH}"
else
    AO_LAUNCH=(ao)
    AO_MATCH="$(command -v ao 2>/dev/null || true)"
fi

# Build a regex alternation of all configured project names so the liveness
# check accepts any of them as a valid orchestrator. Post-PR #712, a single
# `ao start <one-project>` orchestrator manages polling for ALL projects in
# the config — calling `ao start <other-project>` while one is already running
# fails with "AO is already running".
PROJECT_ALT="$(build_project_alt "$PROJECTS")"

# Anchor project — used to launch `ao start <anchor>` if no orchestrator is
# running. We accept ANY `ao start <one-of-our-projects>` as evidence of a
# healthy orchestrator, not just the anchor.
ANCHOR_PROJECT="$(echo "$PROJECTS" | awk '{print $1}')"

orchestrator_alive=false
# Match `start <project>` in the cmdline. The orchestrator process is launched
# as `node <dist>/index.js start <project>` (the `ao` binary is just a node
# wrapper script), so we match the bare `start <project>` substring rather
# than the literal `ao start` which only appears in the global-symlink wrapper.
if [ -n "$AO_MATCH" ]; then
    matching=$(pgrep -f "start[[:space:]]($PROJECT_ALT)([[:space:]]|$)" 2>/dev/null || true)
    for pid in $matching; do
        CMD=$(ps -p "$pid" -o args= 2>/dev/null) || continue
        if command_matches_ao_binary "$CMD" "$AO_MATCH"; then orchestrator_alive=true; break; fi
    done
else
    # No binary path — fall back to unscoped pgrep (legacy behavior)
    if pgrep -f "start[[:space:]]($PROJECT_ALT)([[:space:]]|$)" > /dev/null 2>&1; then
        orchestrator_alive=true
    fi
fi

if [ "$orchestrator_alive" = "true" ]; then
    log "OK: orchestrator already running (single in-process polling for all projects)"
else
    # Clean up stale running.json if its PID is dead. `ao start` refuses to
    # start a new orchestrator when ~/.agent-orchestrator/running.json names
    # a PID that is no longer alive ("AO is already running" then exits).
    RUNNING_JSON="${HOME}/.agent-orchestrator/running.json"
    if should_clean_stale_running_json "$RUNNING_JSON"; then
        STALE_PID=$(grep -o '"pid":[[:space:]]*[0-9]*' "$RUNNING_JSON" 2>/dev/null | grep -o '[0-9]*' | head -1 || true)
        log "CLEANUP: removing stale running.json (dead PID $STALE_PID)"
        rm -f "$RUNNING_JSON"
    fi

    log "START: orchestrator missing, starting... (cmd=${AO_LAUNCH[*]} start $ANCHOR_PROJECT --no-dashboard --no-open --allow-main-repo)"
    # bd-#667: --no-open suppresses the dashboard browser open even if the
    # config or env prefers it. Belt-and-suspenders: the ai.agento.health
    # launchd plist also exports AO_NO_OPEN_BROWSER=1.
    AO_CONFIG_PATH="$CONFIG_PATH" nohup "${AO_LAUNCH[@]}" start "$ANCHOR_PROJECT" --no-dashboard --no-open --allow-main-repo >> "$LOG_FILE" 2>&1 &
    disown
    STARTED=$((STARTED + 1))

    # Retry pgrep up to 5 times (1s apart) to handle slow process startup and
    # "already running" cases where the new orchestrator exits immediately.
    started_ok=false
    for _attempt in 1 2 3 4 5; do
        sleep 1
        started_pids=$(pgrep -f "start[[:space:]]($PROJECT_ALT)([[:space:]]|$)" 2>/dev/null || true)
        for spid in $started_pids; do
            SCMD=$(ps -p "$spid" -o args= 2>/dev/null) || continue
            if [ -n "$AO_MATCH" ]; then
                if command_matches_ao_binary "$SCMD" "$AO_MATCH"; then started_ok=true; break 2; fi
            else
                started_ok=true; break 2
            fi
        done
    done
    if [ "$started_ok" = "true" ]; then
        log "OK: orchestrator started"
    else
        log "FAIL: orchestrator failed to start"
        FAILURES=$((FAILURES + 1))
    fi
fi

# ── Kill orphan orchestrators (ao start PIDs not matching any project) ───────
# bd-#667 / PR #712: orphan sweep now matches `start <project>` (any cmdline
# shape) instead of the deleted `lifecycle-worker` subprocess. We accept ANY
# configured project as a valid anchor — only kill orchestrators that aren't
# anchored to any of our configured projects.
#
# Use the same robust `start[[:space:]]...` pattern as the liveness check above
# (matches both `ao start <project>` and `node <dist>/index.js start <project>`)
# but WITHOUT the PROJECT_ALT restriction — the inner grep below filters
# anchored vs orphan. The previous `pgrep -f "ao start"` only matched the
# global-symlink wrapper, leaving `node <dist>/index.js start <project>`
# orphans un-swept.
ALL_PIDS=$(pgrep -f "$(orchestrator_orphan_sweep_pattern)" 2>/dev/null) || true
KILLED=0

for pid in $ALL_PIDS; do
    CMD=$(ps -p "$pid" -o args= 2>/dev/null) || continue
    # Avoid killing workers from another install — match this host's AO binary path when known.
    if [ -n "$AO_MATCH" ]; then
        command_matches_ao_binary "$CMD" "$AO_MATCH" || continue
    fi
    if echo "$CMD" | grep -qE "start[[:space:]]($PROJECT_ALT)([[:space:]]|$)"; then
        continue  # anchored to one of our projects — keep it
    fi
    log "KILL: orphan orchestrator PID $pid: $CMD"
    kill "$pid" 2>/dev/null || true
    KILLED=$((KILLED + 1))
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
# Always exit 0 so launchd's StartInterval fires every 5 min without throttling.
# Non-zero exit activates KeepAlive (immediate respawn), causing crash-loop throttle.
exit 0
