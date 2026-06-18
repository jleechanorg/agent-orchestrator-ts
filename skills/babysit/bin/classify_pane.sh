#!/usr/bin/env bash
# classify_pane.sh — pure-bash state classifier for tmux capture-pane output.
# Usage: classify_pane.sh <pane-output-file-or-stdin>
# Prints one of: WORKING | COMPLETED | STALLED-COMPLETED | IDLE | QUEUED | TUI-BLOCKED | DEAD
#
# Detection order matters — most-specific signal first.
# - DEAD: no activity indicators AND no prompt AND short content
# - TUI-BLOCKED: trust prompt visible
# - QUEUED: "Press up to edit queued messages" present
# - STALLED-COMPLETED: "Baked" or "Sautéed" with duration ≥ 30m
# - COMPLETED: "Baked" or "Sautéed" with any duration (caught by STALLED if ≥ 30m)
# - WORKING: activity indicators OR in-flight tool use
# - IDLE: bare prompt with no other signal
set -euo pipefail

input="${1:-/dev/stdin}"
content=$(cat "$input")
lines=$(echo "$content" | wc -l)

# 1. TUI blocked — trust prompt visible (check before DEAD; trust prompt has no ❯)
if echo "$content" | grep -q "Do you trust the contents of this project"; then
  echo "TUI-BLOCKED"
  exit 0
fi

# 2. Dead — no `❯` prompt AND no activity indicators AND short content (< 10 lines)
if ! echo "$content" | grep -q "❯" \
   && ! echo "$content" | grep -qE "[✻✶✳✽✾]" \
   && [[ $lines -lt 10 ]]; then
  echo "DEAD"
  exit 0
fi

# 3. Queued — "Press up to edit queued messages"
if echo "$content" | grep -q "Press up to edit queued messages"; then
  echo "QUEUED"
  exit 0
fi

# 4. Stalled completed — Baked/Sautéed for ≥ 30m
if echo "$content" | grep -qE "(Baked|Sautéed) for [3-9][0-9]m|[0-9]+h"; then
  echo "STALLED-COMPLETED"
  exit 0
fi

# 5. Completed (recent) — Baked/Sautéed any duration
if echo "$content" | grep -qE "(Baked|Sautéed) for [0-9]+m"; then
  echo "COMPLETED"
  exit 0
fi

# 6. Working — activity indicator OR in-flight tool use OR running command
if echo "$content" | grep -qE "[✻✶✳✽✾] [A-Za-z]+…"; then
  echo "WORKING"
  exit 0
fi
if echo "$content" | grep -qE "Bash\(|Read\(|Edit\(|Write\(|Grep\(|Glob\("; then
  echo "WORKING"
  exit 0
fi
if echo "$content" | grep -qE "Running…|timeout|⏱"; then
  echo "WORKING"
  exit 0
fi

# 7. Default: bare prompt with no other signal
echo "IDLE"
