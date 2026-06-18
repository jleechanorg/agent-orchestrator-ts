#!/usr/bin/env bash
# watch_worker.sh — babysit watch loop for one or more AO worker sessions.
# Usage: watch_worker.sh <session-name> [--max-min N] [--poll-sec N]
#        watch_worker.sh --all [--max-min N] [--poll-sec N]
# Loops every --poll-sec (default 60s), classifies state, applies remediation
# policy, prints table every 5 min or on every transition.
#
# Sentinel layout: ~/.cache/babysit/${session}.{last_enter,last_notify,last_state,started_at}
# Idempotency: Enter is gated to 1 per 60s; push-notify to 1 per 30m.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIFY="$SKILL_DIR/bin/classify_pane.sh"
CACHE="$HOME/.cache/babysit"
mkdir -p "$CACHE"

session=""
max_min=90
poll_sec=60
all=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-min)  max_min="$2"; shift 2 ;;
    --poll-sec) poll_sec="$2"; shift 2 ;;
    --all)      all=true; shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *)          session="$1"; shift ;;
  esac
done

if [[ -z "$session" ]] && [[ "$all" != true ]]; then
  echo "Usage: $0 <session> [--max-min N] [--poll-sec N]" >&2
  echo "       $0 --all [--max-min N] [--poll-sec N]" >&2
  exit 2
fi

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
since_min() { python3 -c "import time; print(round((time.time()*1000 - $1)/60000, 1))"; }

# Pick sessions
if [[ "$all" == true ]]; then
  mapfile -t sessions < <(tmux list-sessions 2>/dev/null | grep "ao-[0-9]" | cut -d: -f1)
else
  if ! tmux has-session -t "$session" 2>/dev/null; then
    echo "ERROR: tmux session '$session' does not exist" >&2
    exit 1
  fi
  sessions=("$session")
fi

[[ ${#sessions[@]} -eq 0 ]] && { echo "No ao-* sessions found"; exit 0; }

if [[ ${#sessions[@]} -gt 8 ]]; then
  echo "WARNING: ${#sessions[@]} sessions exceeds 8-worker cap; truncating" >&2
  sessions=("${sessions[@]:0:8}")
fi

# Init sentinels
start_ms=$(now_ms)
for s in "${sessions[@]}"; do
  [[ -f "$CACHE/${s}.started_at" ]] || echo "$start_ms" > "$CACHE/${s}.started_at"
done

deadline=$(( $(date +%s) + max_min * 60 ))
last_table_at=0
last_state=()

echo "Babysit watching ${#sessions[@]} session(s). Poll=${poll_sec}s, max=${max_min}m."
echo "  Sessions: ${sessions[*]}"

while [[ $(date +%s) -lt $deadline ]]; do
  any_transition=0
  rows=()
  for s in "${sessions[@]}"; do
    content=$(tmux capture-pane -t "$s" -p -S -30 2>/dev/null || echo "")
    if [[ -z "$content" ]]; then
      state="DEAD"
    else
      state=$(echo "$content" | bash "$CLASSIFY" /dev/stdin)
    fi

    # TUI-BLOCKED remediation: send Enter once per 60s
    if [[ "$state" == "TUI-BLOCKED" ]]; then
      last_enter_file="$CACHE/${s}.last_enter"
      last_enter=$(cat "$last_enter_file" 2>/dev/null || echo 0)
      age_ms=$(( $(now_ms) - last_enter ))
      if [[ $age_ms -gt 60000 ]]; then
        tmux send-keys -t "$s" Enter
        now=$(now_ms)
        echo "$now" > "$last_enter_file"
        echo "  [$(date +%H:%M:%S)] $s: TUI-BLOCKED → sent Enter"
        any_transition=1
      fi
    fi

    # Push-notify on STALLED-COMPLETED or DEAD transitions (1 per 30 min)
    if [[ "$state" == "STALLED-COMPLETED" || "$state" == "DEAD" ]]; then
      last_state_file="$CACHE/${s}.last_state"
      last_n_file="$CACHE/${s}.last_notify"
      prev_state=$(cat "$last_state_file" 2>/dev/null || echo "")
      last_notify=$(cat "$last_n_file" 2>/dev/null || echo 0)
      age_ms=$(( $(now_ms) - last_notify ))
      if [[ "$prev_state" != "$state" ]] || [[ $age_ms -gt 1800000 ]]; then
        started=$(cat "$CACHE/${s}.started_at")
        elapsed=$(since_min "$started")
        echo "[NOTIFY] $s: $state for ${elapsed}m — review or respawn required" >&2
        echo "$(now_ms)" > "$last_n_file"
        any_transition=1
      fi
    fi

    # Update last_state
    echo "$state" > "$CACHE/${s}.last_state"

    # Pull PR + uncommitted
    pr=$(echo "$content" | grep -oE "PR: #[0-9]+" | head -1 || true)
    uc=""; echo "$content" | grep -q "uncommitted" && uc="+uc"
    rows+=("$s|$state|$pr|$uc")
  done

  # Print table every 5 min OR on transition
  if [[ $any_transition -eq 1 ]] || [[ $(( $(date +%s) - last_table_at )) -ge 300 ]]; then
    echo
    echo "Session         State                PR      Uncommitted"
    echo "--------------- -------------------- ------- -----------"
    for r in "${rows[@]}"; do
      IFS='|' read -r s st p u <<< "$r"
      printf "%-15s %-20s %-7s %s\n" "$s" "$st" "$p" "$u"
    done
    last_table_at=$(date +%s)
  fi

  # Exit condition: all sessions COMPLETED + pr merged/closed (we approximate COMPLETED-only)
  completed_count=0
  for r in "${rows[@]}"; do
    [[ "$r" == *"|COMPLETED|"* ]] && completed_count=$((completed_count + 1))
  done
  if [[ $completed_count -eq ${#sessions[@]} ]]; then
    echo "[$(date +%H:%M:%S)] All watched sessions COMPLETED — exiting"
    break
  fi

  sleep "$poll_sec"
done

echo "Babysit watch loop ended (max-min=$max_min reached or all completed)."
