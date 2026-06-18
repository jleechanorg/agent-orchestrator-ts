#!/usr/bin/env bash
# audit-launchd-drift.sh — nightly audit of broken launchd plists
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

# launchd-env-wrapper.sh is invoked by the plist as the ProgramArguments[0]
# entry — it sources .bashrc + .profile, exports the SLACK_* and
# HERMES_OPS_SLACK_CHANNEL vars, then `exec "$@"` this script. We don't
# source it from here because the wrapper ends with `exec "$@"` and would
# kill this process. The plist's EnvironmentVariables block is the source of
# truth; HERMES_OPS_SLACK_CHANNEL falls back to whatever the wrapper
# exported when run by launchd.

# Channel + token resolution matches scripts/hermes-watchdog.sh: plist is
# source of truth, HERMES_OPS_SLACK_CHANNEL is the cross-job fallback.
HERMES_OPS_SLACK_CHANNEL="${HERMES_OPS_SLACK_CHANNEL:-}"
LAUNCHCTL_LABEL_RE='^-[[:space:]]+127[[:space:]]+'

# Collect labels whose status column is exactly 127.
DRIFT_LABELS="$(launchctl list 2>/dev/null \
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

curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$PAYLOAD" \
  https://slack.com/api/chat.postMessage >/dev/null \
  || echo "WARN: Slack post returned non-zero (drift still listed above)" >&2

exit 1
