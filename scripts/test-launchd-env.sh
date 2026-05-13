#!/bin/bash
# Verify lifecycle-workers have all required env vars in their environment.
# Run after `bash scripts/setup-launchd.sh health` to confirm the plist
# installed correctly and the env vars propagated to running processes.
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more required vars missing or invalid in workers
#   2 — no lifecycle-worker processes found (may mean workers haven't restarted yet)

set -euo pipefail

FAILED=0
PLIST_PATH="${HOME}/Library/LaunchAgents/ai.agento.health.plist"

# Step 0: Verify no unsubstituted @VAR@ tokens remain in the plist.
# If @VAR@ placeholders remain unsubstituted, launchd passes invalid env values and workers get 401 on every API call.
if [ -f "$PLIST_PATH" ]; then
  # Strip XML comments before checking — @VAR@ in comments is cosmetic, not functional.
  unsubstituted=$(sed '/<!--/,/-->/d' "$PLIST_PATH" | grep -o '@[A-Z_][A-Z0-9_]*@' 2>/dev/null | sort -u || true)
  if [ -n "$unsubstituted" ]; then
    echo "FAIL: Unsubstituted template variables in $PLIST_PATH:"
    echo "$unsubstituted"
    echo "These expand to empty strings in launchd env, causing 401 auth failures."
    echo "Fix: re-run bash scripts/setup-launchd.sh health"
    exit 1
  fi
else
  echo "FAIL: Missing expected plist at $PLIST_PATH"
  echo "Fix: bash scripts/setup-launchd.sh health"
  exit 1
fi

# Find the youngest lifecycle-worker PID (most recently spawned).
# We pick the youngest because ao-health.sh kills old workers before spawning new ones,
# so the highest-PID worker is the one started after the last plist install.
# Filter out workers from stale sessions (e.g., source-tree dist/index.js paths).
youngest_pid=$(
  pgrep -f "lifecycle-worker" | sort -n | tail -1 || true
)

if [ -z "$youngest_pid" ]; then
  echo "ERROR: No lifecycle-worker process found."
  echo "  Workers may not have restarted yet after plist install."
  echo "  Try: launchctl kickstart -k gui/$(id -u)/ai.agento.health && sleep 5"
  exit 2
fi

echo "Checking youngest lifecycle-worker PID: $youngest_pid"

# Check GITHUB_TOKEN (needed for gh auth in skeptic-cron)
mask_secret() {
  local v="${1:-}"
  if [ -z "$v" ]; then
    printf '%s' "<empty>"
  else
    printf '%s' "${v:0:4}***"
  fi
}

gh_token=$(ps eww -p "$youngest_pid" 2>/dev/null | tr ' ' '\n' | grep "^GITHUB_TOKEN=" || true)
gh_token_value="${gh_token#*=}"
if [ -z "$gh_token_value" ]; then
  echo "FAIL: GITHUB_TOKEN is not set in PID $youngest_pid"
  echo "  gh CLI will fail inside skeptic-cron — no VERDICT comments posted on PRs"
  FAILED=1
elif [ -n "$(echo "$gh_token_value" | tr -d ' \n')" ]; then
  echo "PASS: GITHUB_TOKEN is present in PID $youngest_pid ($(mask_secret "$gh_token_value"))"
else
  echo "FAIL: GITHUB_TOKEN is present but empty in PID $youngest_pid"
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
  echo "  bash scripts/setup-launchd.sh health"
  echo "Then: launchctl kickstart -k gui/\$(id -u)/ai.agento.health"
  exit 1
fi

echo ""
echo "All env var checks passed."
exit 0