#!/bin/bash
# Verify lifecycle-workers have MINIMAX_API_KEY in their environment.
# Run after `bash scripts/setup-launchd.sh lifecycle` to confirm the plist
# installed correctly and the env var propagated to running processes.
#
# Exit codes:
#   0 — all checks pass (MINIMAX_API_KEY, MINIMAX_BASE_URL, MINIMAX_MODEL, GITHUB_TOKEN)
#   1 — one or more required env vars missing or empty in workers
#   2 — no lifecycle-worker processes found (may mean workers haven't restarted yet)

set -euo pipefail

FAILED=0

# Find the youngest lifecycle-worker PID (most recently spawned).
# We pick the youngest because start-all.sh kills old workers before spawning new ones,
# so the highest-PID worker is the one started after the last plist install.
 youngest_pid=$(
  ps aux | grep "lifecycle-worker" | grep -v grep | awk '{print $2}' | sort -n | tail -1
)

if [ -z "$youngest_pid" ]; then
  echo "ERROR: No lifecycle-worker process found."
  echo "  Workers may not have restarted yet after plist install."
  echo "  Try: launchctl kickstart -k gui/$(id -u)/ai.agento.lifecycle-all && sleep 5"
  exit 2
fi

echo "Checking youngest lifecycle-worker PID: $youngest_pid"

# Check GITHUB_TOKEN (needed for gh auth in skeptic-cron)
gh_token=$(ps eww -p "$youngest_pid" 2>/dev/null | tr ' ' '\n' | grep "^GITHUB_TOKEN=" || true)
if [ -z "$gh_token" ]; then
  echo "FAIL: GITHUB_TOKEN is not set in PID $youngest_pid"
  echo "  gh CLI will fail inside skeptic-cron — no VERDICT comments posted on PRs"
  FAILED=1
elif echo "$gh_token" | grep -q 'ghp_'; then
  echo "PASS: GITHUB_TOKEN is present in PID $youngest_pid"
else
  echo "FAIL: GITHUB_TOKEN is present but wrong: $gh_token"
  FAILED=1
fi

# Check environment via ps eww (extended format shows exported env vars)
key_value=$(ps eww -p "$youngest_pid" 2>/dev/null | tr ' ' '\n' | grep "^MINIMAX_API_KEY=" || true)

if [ -z "$key_value" ]; then
  echo "FAIL: MINIMAX_API_KEY is not set in PID $youngest_pid"
  echo "  ps eww -p $youngest_pid shows:"
  ps eww -p "$youngest_pid" 2>/dev/null | tr ' ' '\n' | grep -E "MINIMAX|ANTHROPIC" || echo "  (no MINIMAX/ANTHROPIC vars found)"
  FAILED=1
elif echo "$key_value" | grep -q "sk-cp-Rg64"; then
  echo "PASS: MINIMAX_API_KEY is present and non-empty in PID $youngest_pid"
else
  echo "FAIL: MINIMAX_API_KEY is present but appears truncated or wrong:"
  echo "  $key_value"
  FAILED=1
fi

# Also check BASE_URL and MODEL are present
for var in MINIMAX_ANTHROPIC_BASE_URL MINIMAX_MODEL; do
  val=$(ps eww -p "$youngest_pid" 2>/dev/null | tr ' ' '\n' | grep "^${var}=" || true)
  if [ -z "$val" ]; then
    echo "FAIL: $var is not set in PID $youngest_pid"
    FAILED=1
  else
    echo "PASS: $val"
  fi
done

if [ $FAILED -eq 1 ]; then
  echo ""
  echo "Fix: re-run setup-launchd.sh to reinstall the plist with correct env vars:"
  echo "  bash scripts/setup-launchd.sh lifecycle"
  echo "Then: launchctl kickstart -k gui/\$(id -u)/ai.agento.lifecycle-all"
  exit 1
fi

echo ""
echo "All env var checks passed."
exit 0