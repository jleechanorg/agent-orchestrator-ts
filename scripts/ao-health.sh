#!/usr/bin/env bash
# ao-health.sh — Unified AO health check and remediation.
#
# Replaces: start-all.sh (launcher) + lw-watchdog.sh (monitor) + their plists.
# Called every 5 min by launchd ai.agento.health.
# Ensures ao start <project> (in-process polling) is running for all configured projects.
# Idempotent — safe to run at any time.

set -uo pipefail

# Escape a string for use in an ERE (extended regular expression).
escape_ere() { printf '%s' "$1" | sed 's/[][().*^$+?{}|\\]/\\&/g'; }

# Resolve symlinks — matches setup-launchd.sh behavior so that a worker
# launched via a symlinked binary (e.g. /Users/.../bin/ao -> pnpm shim)
# is correctly recognized by the health job.
resolve_path() {
  python3 - "$1" <<'PY' 2>/dev/null || printf '%s\n' "$1"
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
}

# Check whether a process command line matches this install's AO binary,
# accounting for symlinks and /private prefix on macOS.
# Also resolves the CMD binary itself so that two different symlinks to the
# same real file (e.g. /Users/.../bin/ao -> .nvm/.../bin/ao -> dist/index.js)
# are correctly recognised as the same binary.
command_matches_ao_binary() {
  local cmd="$1"
  local ao_bin="$2"
  local ao_real cmd_bin cmd_real
  ao_real="$(resolve_path "$ao_bin")"
  local ao_alt="${ao_bin#/private}"
  local ao_real_alt="${ao_real#/private}"
  if [[ "$cmd" == *"$ao_bin"* || "$cmd" == *"$ao_alt"* || "$cmd" == *"$ao_real"* || "$cmd" == *"$ao_real_alt"* ]]; then
    return 0
  fi
  cmd_bin=$(echo "$cmd" | grep -oE '(/[^ ]+/ao)( |$)' | head -1 | xargs 2>/dev/null || true)
  if [ -n "$cmd_bin" ]; then
    cmd_real="$(resolve_path "$cmd_bin")"
    [ "$cmd_real" = "$ao_real" ] && return 0
  fi
  return 1
}

# ── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${AO_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
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

# ── Wafer endpoint canary probe ────────────────────────────────────────────────
# Probes the wafer API to verify auth is valid, not just that the process runs.
# Distinguishes three states: (a) reachable + auth valid, (b) auth expired/bad,
# (c) endpoint unreachable.
probe_wafer_endpoint() {
  local api_key="${WAFER_API_KEY:-}"

  if [ -z "$api_key" ]; then
    return 0
  fi

  local resp http_code hdr_file
  hdr_file=$(mktemp "${TMPDIR:-/tmp}/ao-health-hdr.XXXXXX")
  printf 'Authorization: Bearer %s' "$api_key" > "$hdr_file"
  resp=$(curl -s -w "\n%{http_code}" \
    --max-time 15 \
    -H @"$hdr_file" \
    "https://pass.wafer.ai/v1/models" 2>/dev/null || true)
  rm -f "$hdr_file"

  http_code=$(printf '%s' "$resp" | tail -1)

  case "$http_code" in
    200) log "OK: wafer endpoint auth valid" ;;
    401|403) log "WARN: wafer auth invalid/expired (HTTP $http_code)" ;;
    000) log "WARN: wafer endpoint unreachable (curl timeout/DNS)" ;;
    *) log "WARN: wafer endpoint returned HTTP $http_code" ;;
  esac
  return 0
}

# ── Discover projects ────────────────────────────────────────────────────────
CONFIG_PATH=$(ao_find_config_path) || { log "FATAL: no config found"; exit 1; }

# Pre-load WAFER_API_KEY from the same sources AO workers use:
# 1. Shell environment (set via launchd wrapper or parent shell)
# 2. envSource (default: ~/.bashrc — mirrors AO bootstrapEnvSource)
# 3. YAML config plugins section (fallback for explicit config-only setups)
if [ -z "${WAFER_API_KEY:-}" ]; then
  WAFER_API_KEY=$(bash --noprofile --norc -c 'source ~/.bashrc 2>/dev/null; printf "%s" "${WAFER_API_KEY:-}"' 2>/dev/null || true)
fi
if [ -z "${WAFER_API_KEY:-}" ]; then
  WAFER_API_KEY=$(python3 - "$CONFIG_PATH" <<'PYEOF' 2>/dev/null
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1])) or {}
print(cfg.get('plugins', {}).get('WAFER_API_KEY', ''))
PYEOF
)
fi

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
PROJECT_ALT=""
for p in $PROJECTS; do
    ep="$(escape_ere "$p")"
    if [ -z "$PROJECT_ALT" ]; then
        PROJECT_ALT="$ep"
    else
        PROJECT_ALT="$PROJECT_ALT|$ep"
    fi
done

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
    if [ -f "$RUNNING_JSON" ]; then
        STALE_PID=$(grep -o '"pid":[[:space:]]*[0-9]*' "$RUNNING_JSON" 2>/dev/null | grep -o '[0-9]*' | head -1 || true)
        if [ -n "$STALE_PID" ] && ! kill -0 "$STALE_PID" 2>/dev/null; then
            log "CLEANUP: removing stale running.json (dead PID $STALE_PID)"
            rm -f "$RUNNING_JSON"
        fi
    fi

    log "START: orchestrator missing, starting... (cmd=${AO_LAUNCH[*]} start $ANCHOR_PROJECT --no-dashboard --no-open)"
    # bd-#667: --no-open suppresses the dashboard browser open even if the
    # config or env prefers it. Belt-and-suspenders: the ai.agento.health
    # launchd plist also exports AO_NO_OPEN_BROWSER=1.
    AO_CONFIG_PATH="$CONFIG_PATH" nohup "${AO_LAUNCH[@]}" start "$ANCHOR_PROJECT" --no-dashboard --no-open >> "$LOG_FILE" 2>&1 &
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

# Wafer endpoint canary — run once after the orchestrator check so it
# probes every iteration regardless of whether the orchestrator was already
# running (the in-loop probe was skipped when orchestrator was healthy).
probe_wafer_endpoint

# ── Kill orphan orchestrators (ao start PIDs not matching any project) ───────
# bd-#667 / PR #712: orphan sweep now matches `ao start <project>` instead of
# the deleted `lifecycle-worker` subprocess. We accept ANY configured project
# as a valid anchor — only kill orchestrators that aren't anchored to any of
# our configured projects.
ALL_PIDS=$(pgrep -f "ao start" 2>/dev/null) || true
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
