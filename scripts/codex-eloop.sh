#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EVOLVE_CYCLE_SCRIPT="${EVOLVE_CYCLE_SCRIPT:-$REPO_ROOT/scripts/codex-evolve-cycle.sh}"
TOP_COVERAGE_SCRIPT="${TOP_COVERAGE_SCRIPT:-$REPO_ROOT/scripts/ensure-top-pr-coverage.sh}"

MAX_RUNTIME_SECONDS="${MAX_RUNTIME_SECONDS:-10800}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-600}"
CHECK_TIMEOUT_SECONDS="${CHECK_TIMEOUT_SECONDS:-60}"
TMUX_SESSION_BUDGET="${TMUX_SESSION_BUDGET:-20}"
TOP_PR_COVERAGE_TARGET="${TOP_PR_COVERAGE_TARGET:-5}"
CLAW_COMMAND_FILE="${CLAW_COMMAND_FILE:-$HOME/.claude/commands/claw.md}"
ELOOP_SKILL_FILE="${ELOOP_SKILL_FILE:-$HOME/.claude/skills/evolve-loop/SKILL.md}"

if ! [[ "$MAX_RUNTIME_SECONDS" =~ ^[0-9]+$ ]] || [ "$MAX_RUNTIME_SECONDS" -le 0 ]; then
  echo "MAX_RUNTIME_SECONDS must be a positive integer" >&2
  exit 1
fi
if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [ "$INTERVAL_SECONDS" -le 0 ]; then
  echo "INTERVAL_SECONDS must be a positive integer" >&2
  exit 1
fi
if ! [[ "$CHECK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$CHECK_TIMEOUT_SECONDS" -le 0 ]; then
  echo "CHECK_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi
if [ "$MAX_RUNTIME_SECONDS" -gt 10800 ]; then
  echo "Capping MAX_RUNTIME_SECONDS to 10800 (3 hours)"
  MAX_RUNTIME_SECONDS=10800
fi
if [ ! -f "$CLAW_COMMAND_FILE" ]; then
  echo "Missing /claw command file: $CLAW_COMMAND_FILE" >&2
  exit 1
fi
if [ ! -f "$ELOOP_SKILL_FILE" ]; then
  echo "Missing evolve-loop skill file: $ELOOP_SKILL_FILE" >&2
  exit 1
fi
if [ ! -f "$EVOLVE_CYCLE_SCRIPT" ]; then
  echo "Missing evolve cycle script: $EVOLVE_CYCLE_SCRIPT" >&2
  exit 1
fi
if [ ! -f "$TOP_COVERAGE_SCRIPT" ]; then
  echo "Missing top coverage script: $TOP_COVERAGE_SCRIPT" >&2
  exit 1
fi

RUN_CLAW_SCRIPT="$(mktemp /tmp/run-claw.XXXXXX)"
RUN_ELOOP_SKILL="$(mktemp /tmp/evolve-loop.XXXXXX)"
cleanup() {
  rm -f "$RUN_CLAW_SCRIPT"
  rm -f "$RUN_ELOOP_SKILL"
}
trap cleanup EXIT

awk '/^```bash$/{flag=1;next}/^```$/{if(flag){exit}}flag' "$CLAW_COMMAND_FILE" >"$RUN_CLAW_SCRIPT"
chmod +x "$RUN_CLAW_SCRIPT"
if [ ! -s "$RUN_CLAW_SCRIPT" ]; then
  echo "Failed to extract bash payload from $CLAW_COMMAND_FILE" >&2
  exit 1
fi

cp "$ELOOP_SKILL_FILE" "$RUN_ELOOP_SKILL"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

run_check() {
  local label="$1"
  shift
  log "BEGIN $label"
  if timeout "$CHECK_TIMEOUT_SECONDS" "$@"; then
    log "END $label ok"
  else
    local status=$?
    log "END $label failed status=$status"
  fi
}

start_epoch="$(date +%s)"
deadline_epoch=$((start_epoch + MAX_RUNTIME_SECONDS))
cycle=1

log "Starting codex eloop in $REPO_ROOT"
log "Max runtime: ${MAX_RUNTIME_SECONDS}s"
log "Interval: ${INTERVAL_SECONDS}s"
log "Claw command: $CLAW_COMMAND_FILE"
log "Eloop skill: $ELOOP_SKILL_FILE"
log "Eloop local cycle: $EVOLVE_CYCLE_SCRIPT"

while :; do
  now_epoch="$(date +%s)"
  if [ "$now_epoch" -ge "$deadline_epoch" ]; then
    log "Reached max runtime. Exiting."
    break
  fi

  cycle_start="$now_epoch"
  remaining=$((deadline_epoch - cycle_start))
  tmux_sessions="$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')"
  if [ -z "$tmux_sessions" ]; then
    tmux_sessions=0
  fi

  log "Cycle $cycle start (remaining=${remaining}s, tmux_sessions=$tmux_sessions)"

  cd "$REPO_ROOT"
  CYCLE_DIR="/tmp/codex-evolve-loop-cycle-${cycle}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$CYCLE_DIR"
  log "BEGIN local evolve cycle"
  if REPORT_DIR="$CYCLE_DIR" CHECK_TIMEOUT_SECONDS="$CHECK_TIMEOUT_SECONDS" APPEND_ROADMAP=1 bash "$EVOLVE_CYCLE_SCRIPT"; then
    log "END local evolve cycle ok"
  else
    status=$?
    log "END local evolve cycle failed status=$status"
  fi

  log "BEGIN top-$TOP_PR_COVERAGE_TARGET coverage"
  TOP_COVERAGE_OUT="$CYCLE_DIR/top-pr-coverage.out"
  if TOP_N="$TOP_PR_COVERAGE_TARGET" TMUX_SESSION_BUDGET="$TMUX_SESSION_BUDGET" SPAWN_MISSING=1 bash "$TOP_COVERAGE_SCRIPT" >"$TOP_COVERAGE_OUT" 2>&1; then
    log "END top-$TOP_PR_COVERAGE_TARGET coverage ok"
  else
    status=$?
    log "END top-$TOP_PR_COVERAGE_TARGET coverage failed status=$status"
  fi

  if [ "$tmux_sessions" -gt "$TMUX_SESSION_BUDGET" ]; then
    spawn_directive="Do not create new AO workers because active tmux sessions are above ${TMUX_SESSION_BUDGET}. Focus on /claw, OpenClaw gateway drift, duplicate lifecycle-workers, unknown/stuck workers, and safe stabilizing fixes."
  else
    spawn_directive="Create a new AO worker only if it is necessary for a high-signal bug fix and the system appears healthy enough to absorb the load."
  fi

  PRIMARY_ISSUE="$(python3 - "$CYCLE_DIR/summary.json" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.exists():
    print("No summary available from local evolve cycle.")
else:
    data = json.loads(path.read_text())
    print(data.get("primary_issue", "No primary issue recorded."))
PY
)"

  TASK_MESSAGE=$(cat <<EOF
Run one bounded evolve-loop skill cycle in $REPO_ROOT.

Canonical skill body follows from $ELOOP_SKILL_FILE. Use it as the source of truth:

---
$(cat "$RUN_ELOOP_SKILL")
---

Cycle-specific constraints:
- This run is bounded by MAX_RUNTIME_SECONDS=${MAX_RUNTIME_SECONDS} and INTERVAL_SECONDS=${INTERVAL_SECONDS}.
- A Codex-native local evolve cycle already ran and produced artifacts in $CYCLE_DIR.
- Use that local cycle output as the primary observation set rather than redoing the same checks blindly.
- A deterministic top-$TOP_PR_COVERAGE_TARGET coverage pass already ran; use $TOP_COVERAGE_OUT as the source of truth for which high-priority PRs are covered, blocked, or newly spawned.
- Primary friction from the local cycle: $PRIMARY_ISSUE
- Focus on bug fixes to /claw, OpenClaw gateway drift, worker monitoring, and system stability.
- $spawn_directive
- Prefer harness/config fixes over one-off cleanup.
- Return a concise status report with actions taken and current blockers.
EOF
)

  log "BEGIN /claw cycle"
  if ARGUMENTS="$TASK_MESSAGE" bash "$RUN_CLAW_SCRIPT"; then
    log "END /claw cycle ok"
  else
    status=$?
    log "END /claw cycle failed status=$status"
  fi

  cycle_end="$(date +%s)"
  next_sleep=$((INTERVAL_SECONDS - (cycle_end - cycle_start)))
  if [ "$next_sleep" -le 0 ]; then
    log "Cycle exceeded interval; continuing immediately."
  else
    if [ $((cycle_end + next_sleep)) -gt "$deadline_epoch" ]; then
      next_sleep=$((deadline_epoch - cycle_end))
    fi
    if [ "$next_sleep" -gt 0 ]; then
      log "Sleeping ${next_sleep}s before next cycle"
      sleep "$next_sleep"
    fi
  fi

  cycle=$((cycle + 1))
done

log "codex eloop finished"
