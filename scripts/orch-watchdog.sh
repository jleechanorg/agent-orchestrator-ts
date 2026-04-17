#!/usr/bin/env bash
# Orchestrator watchdog — monitors AO lifecycle workers and tmux sessions.
# Runs every 5 minutes via launchd. Supplements launchd KeepAlive for cases
# where launchd loses track of the service.
#
# Installed by: com.agentorchestrator.orch-watchdog.plist
# Logs to: ~/.openclaw/logs/orch-watchdog.stdout/stderr

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.openclaw/logs"
LOG="$LOG_DIR/orch-watchdog.stdout.log"
ERR_LOG="$LOG_DIR/orch-watchdog.stderr.log"
MAX_SESSIONS=20
MIN_SESSIONS=1

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

mkdir -p "$LOG_DIR"

# ── Helper: count active AO tmux sessions ──────────────────────────────────
count_active_sessions() {
  tmux list-sessions 2>/dev/null | grep -E '^([a-f0-9]+-)?(ao|jc|wa|cc|ra|wc)-[0-9]+$' | wc -l | tr -d ' '
}

# ── Helper: find dead stuck sessions (401 auth, no output in 10min) ───────
kill_stuck_sessions() {
  local killed=0
  for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^([a-f0-9]+-)?(ao|jc|wa|wc|cc|ra)-[0-9]+$'); do
    # Check for 401 auth error in last 5 lines of pane
    if tmux capture-pane -t "$sess" -p 2>/dev/null | tail -5 | grep -q "authentication_error\|401\|Please run /login"; then
      echo "[$(ts)] INFO: killing stuck session $sess (auth error detected)" >> "$LOG"
      tmux kill-session -t "$sess" 2>/dev/null || true
      killed=$((killed + 1))
    fi
  done
  echo "[$(ts)] INFO: stuck session cleanup done, killed=$killed" >> "$LOG"
  return 0
}

# ── Helper: check if lifecycle-worker agent-orchestrator is alive ──────────
check_lifecycle_worker() {
  ps aux | grep -q "[l]ifecycle-worker agent-orchestrator"
}

# ── 1. Basic liveness: should always have at least 1 session ───────────────
active_sessions=$(count_active_sessions)
echo "[$(ts)] INFO: active sessions=$active_sessions" >> "$LOG"

# ── 2. Kill stuck sessions ─────────────────────────────────────────────────
kill_stuck_sessions

# ── 3. Check lifecycle worker ───────────────────────────────────────────────
if ! check_lifecycle_worker; then
  echo "[$(ts)] WARN: lifecycle-worker not running — launchd should recover, will check next cycle" >> "$LOG"
fi

# ── 4. Warn if too many sessions ───────────────────────────────────────────
if [ "${active_sessions:-0}" -gt "$MAX_SESSIONS" ]; then
  echo "[$(ts)] WARN: session count=$active_sessions exceeds max=$MAX_SESSIONS — investigate" >> "$LOG"
fi

echo "[$(ts)] INFO: orch-watchdog cycle complete" >> "$LOG"
