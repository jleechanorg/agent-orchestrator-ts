#!/usr/bin/env bash
# Unit test for scripts/audit-launchd-drift.sh
#
# Verifies:
#   1. Empty drift list → exit 0, no Slack post.
#   2. Non-empty drift list → exit 1, Slack post attempted with the
#      HERMES_OPS_SLACK_CHANNEL + OPENCLAW_STAGING_SLACK_BOT_TOKEN pair.
#   3. launchd/ai.hermes.launchd-drift-audit.plist.template validates via
#      plutil -lint (uses @HOME@ placeholders, no hardcoded paths).
#
# Strategy: drive the script with stub binaries on PATH so we don't depend on
# the real launchctl output or hit the real Slack API. The script does
# NOT shell out to `launchctl` directly — it sources launchd-env-wrapper.sh,
# which does `exec "$@"`. Wrapping `launchctl` and `curl` in a temp bin
# lets us assert on call args.
#
# Run: bash tests/unit/test-audit-launchd-drift.sh

set -uo pipefail

PASS=0; FAIL=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/audit-launchd-drift.sh"
PLIST_TEMPLATE="$REPO_ROOT/launchd/ai.hermes.launchd-drift-audit.plist.template"

assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n        got:      %s\n        expected: %s\n" \
      "$label" "$got" "$want"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n        needle:   %s\n        haystack: %s\n" \
      "$label" "$needle" "$haystack"
    FAIL=$((FAIL + 1))
  fi
}

# --- Harness: stub launchctl + curl on PATH, capture call logs. ----------
# launchctl: respects FAKEBIN_LAUNCHCTL_EXIT (non-zero → simulate binary
# failure, stdout is suppressed). curl: respects FAKEBIN_CURL_STDOUT.
make_fakebin() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'echo "$@" >> "$FAKEBIN_LAUNCHCTL_LOG"' \
    'if [ -n "${FAKEBIN_LAUNCHCTL_EXIT:-}" ]; then exit "$FAKEBIN_LAUNCHCTL_EXIT"; fi' \
    'printf "%s\n" "$FAKEBIN_LAUNCHCTL_STDOUT"' \
    > "$dir/launchctl"
  chmod +x "$dir/launchctl"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'echo "$@" >> "$FAKEBIN_CURL_LOG"' \
    'printf "%s\n" "$FAKEBIN_CURL_STDOUT"' \
    > "$dir/curl"
  chmod +x "$dir/curl"
}

run_script() {
  # Args: <fakebin_dir> <launchctl_stdout> <slack_token> <slack_channel> [curl_stdout]
  local fbin="$1" lc_out="$2" token="$3" channel="$4" curl_out="${5:-{\"ok\":true}}"
  local log_dir
  log_dir="$(mktemp -d)"
  FAKEBIN_LAUNCHCTL_LOG="$log_dir/launchctl.log" \
  FAKEBIN_LAUNCHCTL_STDOUT="$lc_out" \
  FAKEBIN_CURL_LOG="$log_dir/curl.log" \
  FAKEBIN_CURL_STDOUT="$curl_out" \
  HERMES_OPS_SLACK_CHANNEL="$channel" \
  OPENCLAW_STAGING_SLACK_BOT_TOKEN="$token" \
  PATH="$fbin:$PATH" \
    bash "$SCRIPT" > "$log_dir/stdout" 2> "$log_dir/stderr"
  echo "$?"
  echo "---STDOUT---"
  cat "$log_dir/stdout"
  echo "---STDERR---"
  cat "$log_dir/stderr"
  echo "---LAUNCHCTL_CALLS---"
  cat "$log_dir/launchctl.log" 2>/dev/null || echo "(none)"
  echo "---CURL_CALLS---"
  cat "$log_dir/curl.log" 2>/dev/null || echo "(none)"
  echo "---END---"
  rm -rf "$log_dir"
}

echo ""
echo "=== TEST 1: empty drift list → exit 0 + no Slack post ==="
FBIN1="$(mktemp -d)"
make_fakebin "$FBIN1"
EMPTY_LC="$(printf 'PID\tStatus\tLabel\n123\t0\tai.agento.health\n456\t0\tai.hermes.gateway\n')"
OUT1="$(run_script "$FBIN1" "$EMPTY_LC" "xoxb-test-token" "C0OPSCHNL")"
EXIT1="$(echo "$OUT1" | head -1)"
STDOUT1="$(echo "$OUT1" | sed -n '/---STDOUT---/,/---STDERR---/p' | sed '1d;$d')"
CURL1="$(echo "$OUT1" | sed -n '/---CURL_CALLS---/,/---END---/p' | sed '1d;$d')"

assert_eq "exit code is 0 when no drift" "$EXIT1" "0"
assert_contains "stdout reports no drift detected" "$STDOUT1" "no drift detected"
assert_eq "no curl invocation when no drift" "$(echo "$CURL1" | grep -c chat.postMessage || true)" "0"
rm -rf "$FBIN1"

echo ""
echo "=== TEST 2: drift list non-empty → exit 1 + Slack alert ==="
FBIN2="$(mktemp -d)"
make_fakebin "$FBIN2"
DRIFT_LC="$(printf 'PID\tStatus\tLabel\n-\t0\tai.agento.health\n-\t127\tai.broken.plist\n-\t127\tcom.orphan.service\n')"
OUT2="$(run_script "$FBIN2" "$DRIFT_LC" "xoxb-test-token" "C0OPSCHNL")"
EXIT2="$(echo "$OUT2" | head -1)"
STDOUT2="$(echo "$OUT2" | sed -n '/---STDOUT---/,/---STDERR---/p' | sed '1d;$d')"
CURL2="$(echo "$OUT2" | sed -n '/---CURL_CALLS---/,/---END---/p' | sed '1d;$d')"

assert_eq "exit code is 1 when drift present" "$EXIT2" "1"
assert_contains "stdout lists drifting plist ai.broken.plist" "$STDOUT2" "ai.broken.plist"
assert_contains "stdout lists drifting plist com.orphan.service" "$STDOUT2" "com.orphan.service"
assert_contains "curl was invoked with chat.postMessage" "$CURL2" "https://slack.com/api/chat.postMessage"
assert_contains "curl Authorization header carries token" "$CURL2" "Bearer xoxb-test-token"
assert_contains "curl payload targets HERMES_OPS_SLACK_CHANNEL" "$CURL2" "C0OPSCHNL"
rm -rf "$FBIN2"

echo ""
echo "=== TEST 4: launchctl list failure → exit 2 (not masked as clean) ==="
FBIN4="$(mktemp -d)"
make_fakebin "$FBIN4"
# run_script helper doesn't expose LAUNCHCTL_EXIT — call it via FAKEBIN_* env
# by sourcing its fbin on PATH with the var set inline.
log_dir4="$(mktemp -d)"
PATH="$FBIN4:$PATH" \
FAKEBIN_LAUNCHCTL_LOG="$log_dir4/launchctl.log" \
FAKEBIN_LAUNCHCTL_EXIT=1 \
FAKEBIN_CURL_LOG="$log_dir4/curl.log" \
HERMES_OPS_SLACK_CHANNEL="C0OPSCHNL" \
OPENCLAW_STAGING_SLACK_BOT_TOKEN="xoxb-test-token" \
  bash "$SCRIPT" > "$log_dir4/stdout" 2> "$log_dir4/stderr"
EXIT4=$?
STDERR4="$(cat "$log_dir4/stderr")"
CURL4_CALLS="$(cat "$log_dir4/curl.log" 2>/dev/null || true)"

assert_eq "exit code is 2 when launchctl fails" "$EXIT4" "2"
assert_contains "stderr warns about launchctl failure" "$STDERR4" "launchctl list failed"
assert_contains "stderr includes launchctl exit code" "$STDERR4" "exit=1"
assert_eq "no curl invocation when launchctl failed" "$CURL4_CALLS" ""
rm -rf "$FBIN4" "$log_dir4"

echo ""
echo "=== TEST 5: Slack returns ok:false → exit 1 + WARN logged ==="
FBIN5="$(mktemp -d)"
make_fakebin "$FBIN5"
DRIFT_LC5="$(printf 'PID\tStatus\tLabel\n-\t127\tai.broken.plist\n')"
OUT5="$(run_script "$FBIN5" "$DRIFT_LC5" "xoxb-test-token" "C0OPSCHNL" '{"ok":false,"error":"channel_not_found"}')"
EXIT5="$(echo "$OUT5" | head -1)"
STDOUT5="$(echo "$OUT5" | sed -n '/---STDOUT---/,/---STDERR---/p' | sed '1d;$d')"
STDERR5="$(echo "$OUT5" | sed -n '/---STDERR---/,/---LAUNCHCTL_CALLS---/p' | sed '1d;$d')"

assert_eq "exit code is 1 when Slack returns ok:false" "$EXIT5" "1"
assert_contains "stdout still lists drift" "$STDOUT5" "ai.broken.plist"
assert_contains "stderr warns that Slack did not return ok:true" "$STDERR5" "did not return ok:true"
assert_contains "stderr echoes the Slack response body" "$STDERR5" "channel_not_found"
rm -rf "$FBIN5"

echo ""
echo "=== TEST 3: plist template validates via plutil -lint (macOS only) ==="
if [[ ! -f "$PLIST_TEMPLATE" ]]; then
  printf "  FAIL  plist template exists at %s\n" "$PLIST_TEMPLATE"
  FAIL=$((FAIL + 1))
else
  # plutil is macOS-only. On Linux CI we still run the structural checks
  # (placeholder syntax, hardcoded-path guard) and skip the lint assertion.
  if command -v plutil >/dev/null 2>&1; then
    LINT_OUT="$(plutil -lint "$PLIST_TEMPLATE" 2>&1)"
    LINT_EXIT=$?
    assert_eq "plutil -lint exit 0" "$LINT_EXIT" "0"
    assert_contains "plutil OK message" "$LINT_OUT" "OK"
  else
    printf "  SKIP  plutil not available (non-macOS); structural checks below still run\n"
  fi
  # No hardcoded /Users/jleechan paths — only __HOME__ placeholders.
  if grep -q "/Users/jleechan" "$PLIST_TEMPLATE"; then
    printf "  FAIL  template contains hardcoded /Users/jleechan path\n"
    FAIL=$((FAIL + 1))
  else
    printf "  PASS  template has no hardcoded /Users/jleechan path\n"
    PASS=$((PASS + 1))
  fi
  assert_contains "template uses __HOME__ placeholder" "$(cat "$PLIST_TEMPLATE")" "__HOME__"
  assert_contains "template uses __REPO_ROOT__ placeholder" "$(cat "$PLIST_TEMPLATE")" "__REPO_ROOT__"
  # @VAR@ syntax is forbidden in this template (defensive: @ tripped at least
  # one downstream validator even though plutil accepted it).
  if grep -qE '@[A-Z_]+@' "$PLIST_TEMPLATE"; then
    printf "  FAIL  template still contains @VAR@ placeholder syntax\n"
    FAIL=$((FAIL + 1))
  else
    printf "  PASS  template uses __VAR__ syntax (no @VAR@)\n"
    PASS=$((PASS + 1))
  fi
fi

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "OK — audit-launchd-drift behavior + plist template both valid."
  exit 0
else
  echo "UNEXPECTED — got $FAIL real failure(s)"
  exit 1
fi
