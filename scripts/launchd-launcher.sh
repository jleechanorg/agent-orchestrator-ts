#!/bin/bash
# launchd-launcher.sh — thin wrapper for all launchd plists.
#
# Sources the shell profile to inherit env vars (API keys, PATH, etc.),
# then execs the target script passed as $1.
#
# This eliminates the need for plists to duplicate env vars via sed substitution.
# All runtime config comes from the user's shell profile — same as interactive use.

set -euo pipefail

# Source shell profile to inherit all env vars (API keys, PATH, etc.)
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  source "$HOME/.bash_profile"
elif [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

if [ $# -eq 0 ]; then
  echo "ERROR: launchd-launcher.sh requires a target script argument" >&2
  exit 1
fi

TARGET="$1"
shift
exec "$TARGET" "$@"
