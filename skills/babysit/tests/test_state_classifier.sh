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
EOF

# Classify each fixture
fail=0
for fixture in working completed stalled_completed idle queued tui_blocked dead; do
  result=$(bash "$CLASSIFIER" "$FIXTURES/${fixture}.txt")
  echo "  ${fixture}: $result"
  case "$fixture" in
    working)            expected="WORKING" ;;
    completed)          expected="COMPLETED" ;;
    stalled_completed)  expected="STALLED-COMPLETED" ;;
    idle)               expected="IDLE" ;;
    queued)             expected="QUEUED" ;;
    tui_blocked)        expected="TUI-BLOCKED" ;;
    dead)               expected="DEAD" ;;
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
echo "STATE-CLASSIFIER: PASS (7/7)"
