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
# -l: login shell → sources .bash_profile if it exists
# -i: interactive → bypasses .bashrc's "case $- in *i*) ;; *) return;; esac" guard
#
# IMPORTANT: On macOS, a login shell (.bash_profile) does NOT automatically source .bashrc.
# We must explicitly source .bashrc as well to pick up exports placed there by the user.
#
# Filter to only non-empty values to avoid overriding plist defaults with empties.
# Error handling: if shell profile fails to load, log the failure but continue (plist defaults remain).
_exit_code=0
_init_output=$(bash -lic 'declare -x' 2>&1; echo "exit:$?") || _exit_code=$?
# Also explicitly source .bashrc since login shell may not have sourced it
# bash -lic sources .bash_profile which typically sources .bashrc, but not guaranteed.
# Doing it explicitly ensures we get .bashrc-only exports regardless of .bash_profile content.
_bashrc_output=$(bash -ic 'source ~/.bashrc 2>/dev/null || true; declare -x' 2>&1; echo "exit:$?") || true

# Merge outputs from both invocations
_init_output="${_init_output}
${_bashrc_output}"

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
  echo "WARNING: shell profile init exited with code $_actual_exit, continuing with plist defaults" >&2
fi
if [ -z "$_init_output" ]; then
  echo "WARNING: shell profile produced no exports, continuing with plist defaults" >&2
fi

# Build the filtered export list, handling all three quoting cases robustly.
# Rejects empty-valued exports (MINIMAX_MODEL="" or MINIMAX_MODEL='') so plist defaults survive.
_filtered=$(echo "$_init_output" | grep -E \
  'declare -x [A-Za-z_][A-Za-z0-9_]*="[^"]+"[[:space:]]*$|declare -x [A-Za-z_][A-Za-z0-9_]*='\''[^'\'']+'\''[[:space:]]*$|declare -x [A-Za-z_][A-Za-z0-9_]*=[^[:space:]]' \
  || true)
if [ -n "$_filtered" ]; then
  eval "$_filtered" || {
    echo "WARNING: failed to parse shell exports, continuing with plist defaults" >&2
  }
else
  echo "WARNING: shell profile exports were all empty-valued, continuing with plist defaults" >&2
fi

exec "$TARGET" "$@"
