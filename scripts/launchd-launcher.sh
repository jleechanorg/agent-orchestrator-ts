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

# Source shell profile in interactive mode to get all exports (API keys, nvm, etc.)
# bashrc has a "case $- in *i*) ;; *) return;; esac" guard that skips exports
# when not interactive. The -i flag forces past it.
eval "$(bash -ic 'declare -x' 2>/dev/null)" || true

exec "$TARGET" "$@"
