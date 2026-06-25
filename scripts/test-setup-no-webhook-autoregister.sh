#!/usr/bin/env bash
# test-setup-no-webhook-autoregister.sh — bash test harness that locks in
# the upstream-aligned contract for scripts/setup.sh:
#
# 1. setup.sh must NOT auto-invoke scripts/setup-extended.sh (which auto-registers
#    GitHub webhooks during setup). Upstream's agentwrapper/agent-orchestrator
#    does not do this — webhook registration is a fork-specific opt-in
#    (now at scripts/fork/register-webhooks.sh).
# 2. setup.sh must NOT contain the literal string "Registering GitHub webhooks"
#    (which is the user-visible line that setup-extended.sh prints).
# 3. The fork-specific opt-in script must exist at scripts/fork/register-webhooks.sh
#    (or whatever path the convention settles on) and must be marked opt-in.
#
# Why: This is the regression guard for the alignment refactor. After moving the
# auto-register out of setup.sh, future edits that put it back will fail this test.
#
# Exit codes:
#   0 — all checks pass
#   1 — one or more checks failed
#
# Usage: bash scripts/test-setup-no-webhook-autoregister.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SETUP_SH="$REPO_ROOT/scripts/setup.sh"
EXTENDED_SH="$REPO_ROOT/scripts/setup-extended.sh"
FORK_DIR="$REPO_ROOT/scripts/fork"
OPT_IN_SH="$FORK_DIR/register-webhooks.sh"

FAILED=0
PASSED=0

check() {
  local name="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS: $name"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: $name"
    FAILED=$((FAILED + 1))
  fi
}

# ─── Test 1: setup.sh exists ────────────────────────────────────────────────
if [ ! -f "$SETUP_SH" ]; then
  echo "FAIL: setup.sh not found at $SETUP_SH"
  exit 1
fi
check "setup.sh exists" 0

# ─── Test 2: setup.sh does NOT auto-invoke setup-extended.sh ────────────────
# The fork-specific block uses a shell variable `EXTENDED_SCRIPT` to invoke
# setup-extended.sh. So we grep for the variable name appearing in active
# (non-comment, non-assignment) lines:
#   - forbidden: `bash "$EXTENDED_SCRIPT"` or `bash $EXTENDED_SCRIPT`
#   - forbidden: `source "$EXTENDED_SCRIPT"` or `. "$EXTENDED_SCRIPT"`
#   - allowed:   `EXTENDED_SCRIPT="..."` (variable definition only)
# Strategy: find all lines referencing $EXTENDED_SCRIPT, drop assignments and
# comments, and fail if anything remains.
auto_invoke=$(grep -nE '\$EXTENDED_SCRIPT' "$SETUP_SH" \
  | grep -vE ':\s*#' \
  | grep -vE '^[[:space:]]*[0-9]+:[[:space:]]*EXTENDED_SCRIPT=' \
  | grep -vE '^\s*[0-9]+:\s*#' \
  || true)
if [ -n "$auto_invoke" ]; then
  echo "FAIL: setup.sh auto-invokes \$EXTENDED_SCRIPT:"
  echo "$auto_invoke"
  FAILED=$((FAILED + 1))
else
  echo "PASS: setup.sh does not auto-invoke \$EXTENDED_SCRIPT"
  PASSED=$((PASSED + 1))
fi

# Also catch the literal-path variant (in case a future refactor inlines it):
literal_invoke=$(grep -nE 'bash[[:space:]]+"?[^"#]*setup-extended\.sh' "$SETUP_SH" \
  | grep -vE ':\s*#' || true)
if [ -n "$literal_invoke" ]; then
  echo "FAIL: setup.sh uses literal path to invoke setup-extended.sh:"
  echo "$literal_invoke"
  FAILED=$((FAILED + 1))
fi

# ─── Test 3: setup.sh does NOT contain the webhook-registration banner ──────
banner=$(grep -nE "Registering GitHub webhooks" "$SETUP_SH" 2>/dev/null || true)
if [ -n "$banner" ]; then
  echo "FAIL: setup.sh contains 'Registering GitHub webhooks' banner at:"
  echo "$banner"
  FAILED=$((FAILED + 1))
else
  echo "PASS: setup.sh does not contain webhook-registration banner"
  PASSED=$((PASSED + 1))
fi

# ─── Test 3b: setup.sh does NOT start the webhook server (next dev on 3030) ─
# This was also a setup-extended.sh side effect. Upstream's setup.sh does not
# run a webhook server during install.
next_dev_invocation=$(grep -nE 'next[[:space:]]+dev.*--port|webhook-server\.log' "$SETUP_SH" \
  | grep -vE ':\s*#' || true)
if [ -n "$next_dev_invocation" ]; then
  echo "FAIL: setup.sh starts webhook server (next dev):"
  echo "$next_dev_invocation"
  FAILED=$((FAILED + 1))
else
  echo "PASS: setup.sh does not start webhook server (no next dev invocation)"
  PASSED=$((PASSED + 1))
fi

# ─── Test 4: scripts/fork/ exists for fork-specific opt-in scripts ──────────
if [ ! -d "$FORK_DIR" ]; then
  echo "FAIL: scripts/fork/ does not exist — opt-in scripts need a home"
  FAILED=$((FAILED + 1))
else
  echo "PASS: scripts/fork/ exists for fork-specific opt-in scripts"
  PASSED=$((PASSED + 1))
fi

# ─── Test 5: opt-in script exists at scripts/fork/register-webhooks.sh ──────
if [ ! -f "$OPT_IN_SH" ]; then
  echo "FAIL: opt-in script not found at $OPT_IN_SH"
  FAILED=$((FAILED + 1))
else
  echo "PASS: opt-in script exists at $OPT_IN_SH"
  PASSED=$((PASSED + 1))
fi

# ─── Test 6: opt-in script does NOT use http://localhost as a default URL ───
# (upstream-style contract: must require an explicit HTTPS URL, no localhost fallback)
# Strip comment lines (starting with #) and check only active code.
if [ -f "$OPT_IN_SH" ]; then
  localhost_fallback=$(grep -nE 'http://localhost|WEBHOOK_BASE_URL.*localhost' "$OPT_IN_SH" \
    | grep -vE '^\s*[0-9]+:\s*#' \
    | grep -vE 'NO localhost fallback|GitHub rejects' \
    || true)
  if [ -n "$localhost_fallback" ]; then
    echo "FAIL: opt-in script falls back to http://localhost in active code:"
    echo "$localhost_fallback"
    FAILED=$((FAILED + 1))
  else
    echo "PASS: opt-in script does not use http://localhost fallback (active code only)"
    PASSED=$((PASSED + 1))
  fi
fi

# ─── Test 7: setup.sh's last 30 lines do NOT mention "TailScale" or "Funnel" ──
# (upstream-style: setup.sh is about installing the CLI, not about exposing a webhook server)
# Allow if commented out, but not active code.
if [ -f "$SETUP_SH" ]; then
  active_tailscale=$(tail -30 "$SETUP_SH" | grep -vE '^\s*#' | grep -E 'tailscale|funnel' 2>/dev/null || true)
  if [ -n "$active_tailscale" ]; then
    echo "WARN: setup.sh tail mentions tailscale/funnel in active code:"
    echo "$active_tailscale"
    # Don't fail the test — this is informational, the upstream setup.sh has docs links to remote-access
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASSED PASS, $FAILED FAIL"
if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "setup.sh should NOT auto-register webhooks (per upstream alignment)."
  echo "Move the auto-registration to scripts/fork/register-webhooks.sh and"
  echo "remove the invocation from setup.sh."
  exit 1
fi
exit 0
