#!/usr/bin/env bash
# test_state_classifier.sh — verify babysit's state classification primitive
# against synthetic tmux output, no live workers required.
#
# Run: bash tests/test_state_classifier.sh
# Pass criterion: 7/7 tests pass with explicit PASS/FAIL output.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLASSIFIER="${SKILL_DIR}/bin/classify_pane.sh"

# Test fixture: each fixture file is a synthetic tmux capture-pane output
FIXTURES="${SKILL_DIR}/tests/fixtures"
mkdir -p "$FIXTURES"

cat > "$FIXTURES/working.txt" <<'EOF'
  ✻ Germinating… (0m 14s · thought for 2s · ↓ 0 tokens · esc to interrupt)
  Reading packages/core/src/skeptic-cron-local.ts
  ⣾ Running...
  Bash(git show e1f11d0033) (ctrl+o to expand)
EOF

cat > "$FIXTURES/completed.txt" <<'EOF'
  ✻ Baked for 1m 24s
  ⎿  Wrote 3 files to /tmp/spec
  PR #661 | ctx ####------ 46%
  > All done. The spec is committed.
  ❯
EOF

cat > "$FIXTURES/stalled_completed.txt" <<'EOF'
  ✻ Sautéed for 42m
  PR #657 | ctx ###------- 30%
  ❯
EOF

cat > "$FIXTURES/idle.txt" <<'EOF'
  PR #659 | ctx ##-------- 20%
  No recent activity.
  ❯
EOF

cat > "$FIXTURES/queued.txt" <<'EOF'
  Press up to edit queued messages
  [lifecycle-worker] push PR #661 to remote
  ❯
EOF

cat > "$FIXTURES/tui_blocked.txt" <<'EOF'
  Do you trust the contents of this project?

  Antigravity CLI requires permission to read, edit, and execute files here.

  > Yes, I trust this folder
    No, exit

    ↑/↓ Navigate · enter Confirm
                                                         Gemini 3.5 Flash (High)
EOF

cat > "$FIXTURES/dead.txt" <<'EOF'
  [terminal not responding]
  ^C
  [process exited with code 137]
  last output: 2026-06-18T07:31:12Z
  no activity since 12m
  pane size: 80x24
  scrollback: 0 lines
  current tty: /dev/ttys003
  owner: ao-6302
  status: dead
  no prompt visible
  no recent tool output
EOF

# Regression fixture: 2h uptime string in pane must NOT be misread as STALLED-COMPLETED
# (pre-fix regex `(Baked|Sautéed) for [3-9][0-9]m|[0-9]+h` matched any "2h" text).
cat > "$FIXTURES/regression_2h_idle.txt" <<'EOF'
  uptime 2h
  PR #659 | ctx ##-------- 20%
  No recent activity.
  ❯
EOF

# Classify each fixture
fail=0
for fixture in working completed stalled_completed idle queued tui_blocked dead regression_2h_idle; do
  result=$(bash "$CLASSIFIER" "$FIXTURES/${fixture}.txt")
  echo "  ${fixture}: $result"
  case "$fixture" in
    working)              expected="WORKING" ;;
    completed)            expected="COMPLETED" ;;
    stalled_completed)    expected="STALLED-COMPLETED" ;;
    idle)                 expected="IDLE" ;;
    queued)               expected="QUEUED" ;;
    tui_blocked)          expected="TUI-BLOCKED" ;;
    dead)                 expected="DEAD" ;;
    regression_2h_idle)   expected="IDLE" ;;
  esac
  if [[ "$result" != "$expected" ]]; then
    echo "    FAIL: expected $expected, got $result"
    fail=1
  else
    echo "    PASS"
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "STATE-CLASSIFIER: FAIL"
  exit 1
fi
echo "STATE-CLASSIFIER: PASS (8/8)"
