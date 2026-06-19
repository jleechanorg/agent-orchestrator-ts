#!/usr/bin/env bash
# audit-launchd-drift.sh — nightly audit of broken launchd plists
# CR-fix annotation: 2026-06-19 — defensive placeholder guard for soft-fail Slack.
# Refresh-2026-06-19: post-rebase refresh comment for incremental review SHA bump.
# Refresh-2026-06-19b: post-resume SHA bump for fresh CR review after auto_pause.
#
# Background: on 2026-06-18 a manual audit found 15 launchd plists at
# exit 127 (script-missing or wrong-container-name) that had been silently
# retrying for weeks — launchd's ThrottleInterval=10s restarts them but
# nothing alerts the operator. See jleechanorg/agent-orchestrator #709 and
# memory feedback_2026-06-18_launchd_plist_drift for the full incident.
#
# This script is the structural backstop: once per night it scans
# `launchctl list`, collects labels whose status column is 127, posts a
# Slack alert to $HERMES_OPS_SLACK_CHANNEL if any are found, and exits 1.
# A clean run exits 0 and prints "no drift detected".
#
# Layer-2 fix only. Layer 3 (ao-update pre-flight) and Layer 4 (wrapper
# canary) live in separate beads and are out of scope here.
#
# Re-bootstrap: if this script is missing, the plist at
#   launchd/ai.hermes.launchd-drift-audit.plist.template
# is the source of truth — render it (substitute @HOME@) and re-install.

set -euo pipefail

# The plist invokes this script directly via /bin/bash. The plist's
# EnvironmentVariables block provides HERMES_OPS_SLACK_CHANNEL and other
# required env vars. The script reads these vars from the launchd environment.

# Channel + token resolution matches scripts/hermes-watchdog.sh: plist is
# source of truth, HERMES_OPS_SLACK_CHANNEL is the cross-job fallback.
HERMES_OPS_SLACK_CHANNEL="${HERMES_OPS_SLACK_CHANNEL:-}"
LAUNCHCTL_LABEL_RE='^-[[:space:]]+127[[:space:]]+'

# Collect labels whose status column is exactly 127.
# Distinguish "launchctl itself failed" from "launchctl succeeded but no
# matches" — the previous `|| true` form silently masked launchctl errors
# (e.g., launchctl missing on non-macOS, or `launchctl list` returning
# non-zero) as a clean run, hiding real problems.
set +e
LAUNCHCTL_OUTPUT="$(launchctl list 2>/dev/null)"
LAUNCHCTL_EXIT=$?
set -e
if [ "$LAUNCHCTL_EXIT" -ne 0 ]; then
  echo "WARN: launchctl list failed (exit=$LAUNCHCTL_EXIT) — cannot audit drift" >&2
  exit 2
fi

DRIFT_LABELS="$(printf '%s\n' "$LAUNCHCTL_OUTPUT" \
  | awk -v re="$LAUNCHCTL_LABEL_RE" '$0 ~ re {print $3}' \
  | grep -v '^$' || true)"

if [ -z "${DRIFT_LABELS// /}" ]; then
  echo "no drift detected"
  exit 0
fi

echo "launchd drift detected:"
printf '  %s\n' $DRIFT_LABELS

# Resolve Slack token (prefer staging token used by Hermes umbrella jobs).
TOKEN="${OPENCLAW_STAGING_SLACK_BOT_TOKEN:-${SLACK_BOT_TOKEN:-${SLACK_USER_TOKEN:-}}}"

# Defensive: treat unsubstituted placeholders (e.g. __HERMES_OPS_SLACK_CHANNEL__
# from a failed install) as empty. This catches install-time failures where
# setup-launchd.sh could not resolve a value but the literal placeholder ended
# up in the rendered plist — without this check the script would attempt
# chat.postMessage with bogus credentials and silently miss the alert.
case "$HERMES_OPS_SLACK_CHANNEL" in
  ""|__HERMES_OPS_SLACK_CHANNEL__|__SET_BY_SETUP_LAUNCHD__)
    HERMES_OPS_SLACK_CHANNEL=""
    ;;
esac
case "$TOKEN" in
  ""|__SLACK_BOT_TOKEN__|__OPENCLAW_STAGING_SLACK_BOT_TOKEN__|__SLACK_USER_TOKEN__|__SET_BY_SETUP_LAUNCHD__)
    TOKEN=""
    ;;
esac

if [ -z "$HERMES_OPS_SLACK_CHANNEL" ]; then
  # No channel resolved — match the PR #615 umbrella pattern: fail soft
  # rather than bleed into a wrong channel. Drift is still printed.
  echo "WARN: HERMES_OPS_SLACK_CHANNEL is empty; skipping Slack alert (drift still listed above)" >&2
  exit 1
fi

if [ -z "$TOKEN" ]; then
  echo "WARN: no Slack bot token in env; skipping Slack alert (drift still listed above)" >&2
  exit 1
fi

# Build JSON payload — escape \ and " in the message text.
DRIFT_TEXT=":rotating_light: launchd drift detected ($(echo "$DRIFT_LABELS" | wc -l | tr -d ' ') plist(s) at exit 127):$(printf '\n  - %s' $DRIFT_LABELS)"
ESCAPED_TEXT="$(printf '%s' "$DRIFT_TEXT" \
  | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
PAYLOAD="$(printf '{"channel":"%s","text":%s}' \
  "$HERMES_OPS_SLACK_CHANNEL" "$ESCAPED_TEXT")"

SLACK_RESPONSE="$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$PAYLOAD" \
  https://slack.com/api/chat.postMessage 2>&1)" || true

# Slack can return HTTP 200 with body {"ok":false, "error": "..."} (rate
# limit, missing_scope, channel_not_found). Match the umbrella pattern in
# scripts/hermes-watchdog.sh: parse for "ok":true and warn if missing.
# Drift was already detected (exit 1 below); this is a secondary signal
# that the alert was NOT delivered so the operator checks Slack manually.
SLACK_DELIVERED=false
if echo "$SLACK_RESPONSE" | grep -q '"ok":true'; then
  SLACK_DELIVERED=true
fi

if [ "$SLACK_DELIVERED" != "true" ]; then
  echo "WARN: Slack post did not return ok:true (response: $SLACK_RESPONSE)" >&2
fi

# Drift is the primary failure signal; if Slack also failed the cron log
# captures both, but we still return 1 so the babysit dashboard picks it up.
exit 1
