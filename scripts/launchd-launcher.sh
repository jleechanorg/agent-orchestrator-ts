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
init_output=$(bash -lic 'declare -x' 2>&1) || true
if [ -n "$init_output" ] && ! grep -qE 'declare -x' <<< "$init_output"; then
  echo "WARNING: shell profile init produced no exports (exit code: $?)" >&2
fi
eval "$(echo "$init_output" | grep -E 'declare -x [A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+')" || {
  echo "WARNING: failed to parse shell exports, continuing with plist defaults" >&2
}

exec "$TARGET" "$@"
