#!/bin/bash
# launchd-launcher.sh — thin wrapper for all launchd plists.
#
# Sources the shell profile in interactive mode to inherit all env vars
# (API keys, PATH, nvm, etc.), then execs the target script passed as $1.
#
# Uses bash -i to bypass .bashrc's "non-interactive return" guard so
# ALL exports are visible — not just the ones before the guard.
#
# This eliminates the need for plists to duplicate secrets via sed substitution.

set -euo pipefail

if [ $# -eq 0 ]; then
  echo "ERROR: launchd-launcher.sh requires a target script argument" >&2
  exit 1
fi

TARGET="$1"
shift

# Source shell profile in login+interactive mode to get all exports (API keys, nvm, etc.)
# -l: login shell → sources .bash_profile if it exists, falling back to .bashrc
# -i: interactive → bypasses .bashrc's "case $- in *i*) ;; *) return;; esac" guard
# Filter to only values (both single- and double-quoted) to avoid overriding plist defaults with empties.
# Error handling: if shell profile fails to load, log the failure but continue (plist defaults remain).
exit_code=0
_init_output=$(bash -lic 'declare -x' 2>&1; echo "exit:$?") || exit_code=$?
# Extract the bash exit code from the trailing "exit:N" marker
# Only take the first matching line to handle the case where both bash -lic
# and bash -ic produce exit markers (would otherwise give "0\n0" → integer error).
_marker=$(echo "$_init_output" | grep '^exit:' | head -1 || true)
_actual_exit=${_marker#exit:}
# Strip ALL whitespace characters (not just trailing) since the marker may contain
# literal newlines when both bash -lic and bash -ic output markers.
_actual_exit=${_actual_exit//[[:space:]]}
# Guard: ensure _actual_exit is a valid non-negative integer (handle empty/corrupt markers)
case "$_actual_exit" in
  ''|*[^0-9]*) _actual_exit=0 ;;
esac
_init_output=$(echo "$_init_output" | grep -v '^exit:')
if [ "$_actual_exit" -ne 0 ]; then
  echo "WARNING: shell profile init exited with code $_actual_exit" >&2
fi
if [ -z "$_init_output" ]; then
  echo "WARNING: shell profile produced no exports, continuing with plist defaults" >&2
fi
eval "$(echo "$_init_output" | grep -E 'declare -x [A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+')" || {
  echo "WARNING: failed to parse shell exports, continuing with plist defaults" >&2
}

exec "$TARGET" "$@"
