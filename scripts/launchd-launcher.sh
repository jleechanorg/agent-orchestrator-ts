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

# Snapshot plist-provided ANTHROPIC_BASE_URL before shell profile eval can overwrite it.
# If .bashrc exports a stale localhost value (e.g. http://localhost:9000 from lean-proxy),
# we restore the valid plist endpoint after eval instead of losing it.
_plist_base_url="${ANTHROPIC_BASE_URL:-}"

# Source shell profile in login+interactive mode to get all exports (API keys, nvm, etc.)
# -l: login shell → sources .bash_profile if it exists, falling back to .bashrc
# -i: interactive → bypasses .bashrc's "case $- in *i*) ;; *) return;; esac" guard
#
# IMPORTANT: On macOS, a login shell (.bash_profile) does NOT automatically source .bashrc.
# We must explicitly source .bashrc as well to pick up exports placed there by the user.
#
# Filter to only non-empty values to avoid overriding plist defaults with empties.
# Error handling: if shell profile fails to load, log the failure but continue (plist defaults remain).
# Source shell profile in login+interactive mode to get all exports (API keys, nvm, etc.)
_init_output=$(bash -lic 'declare -x' 2>&1; echo "exit:$?") || true
# Also explicitly source .bashrc since login shell may not have sourced it
# bash -lic sources .bash_profile which typically sources .bashrc, but not guaranteed.
# Doing it explicitly ensures we get .bashrc-only exports regardless of .bash_profile content.
_bashrc_output=$(bash -ic 'source ~/.bashrc 2>&1; declare -x' 2>&1; echo "exit:$?") || true

# Extract exit codes from the trailing "exit:N" markers
_init_marker=$(echo "$_init_output" | grep '^exit:' | head -1 || true)
_init_exit=${_init_marker#exit:}
_init_exit=${_init_exit//[[:space:]]}
case "$_init_exit" in
  ''|*[^0-9]*) _init_exit=0 ;;
esac

_bashrc_marker=$(echo "$_bashrc_output" | grep '^exit:' | head -1 || true)
_bashrc_exit=${_bashrc_marker#exit:}
_bashrc_exit=${_bashrc_exit//[[:space:]]}
case "$_bashrc_exit" in
  ''|*[^0-9]*) _bashrc_exit=0 ;;
esac

# Remove the exit markers from the outputs
_init_output=$(echo "$_init_output" | grep -v '^exit:')
_bashrc_output=$(echo "$_bashrc_output" | grep -v '^exit:')

if [ "$_init_exit" -ne 0 ]; then
  echo "WARNING: shell profile init exited with code $_init_exit" >&2
fi

if [ "$_bashrc_exit" -ne 0 ]; then
  echo "WARNING: bash -ic sourcing .bashrc failed (exit $_bashrc_exit), PATH may be incomplete" >&2
fi

# Merge outputs from both invocations
_merged_output="${_init_output}
${_bashrc_output}"

if [ -z "$_merged_output" ]; then
  echo "WARNING: shell profile produced no exports, continuing with plist defaults" >&2
fi
# Only accept exports with non-empty values: quoted ("..." or '...') must have content,
# unquoted values must have at least one non-whitespace character (not just empty quotes).
eval "$(echo "$_merged_output" | grep -E 'declare -x [A-Za-z_][A-Za-z0-9_]*="[^"]+"[[:space:]]*$|declare -x [A-Za-z_][A-Za-z0-9_]*='"'"'[^'"'"']+'"'"'[[:space:]]*$|declare -x [A-Za-z_][A-Za-z0-9_]*=[^[:space:]]' || true)" || {
  echo "WARNING: failed to parse shell exports, continuing with plist defaults" >&2
}

# Fallback PATH augmentation: ensure critical binaries (gh, tmux, git, node) are findable
# even if the shell profile subshell failed or returned an incomplete environment.
# Homebrew on Apple Silicon lives at /opt/homebrew/bin; Intel at /usr/local/bin.
# nvm default alias: resolve via the alias file to avoid hardcoding a version.
_nvm_default_node=""
if [[ -s "${NVM_DIR:-$HOME/.nvm}/alias/default" ]]; then
  _nvm_ver=$(cat "${NVM_DIR:-$HOME/.nvm}/alias/default" | tr -d '[:space:]')
  # Resolve indirection (alias → alias → version)
  for _i in 1 2 3; do
    if [[ -s "${NVM_DIR:-$HOME/.nvm}/alias/$_nvm_ver" ]]; then
      _nvm_ver=$(cat "${NVM_DIR:-$HOME/.nvm}/alias/$_nvm_ver" | tr -d '[:space:]')
    else
      break
    fi
  done
  _nvm_default_node="${NVM_DIR:-$HOME/.nvm}/versions/node/${_nvm_ver}/bin"
fi
for _bin_dir in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin "$HOME/bin" "$HOME/.local/bin" "$_nvm_default_node"; do
  [[ -z "$_bin_dir" || ! -d "$_bin_dir" ]] && continue
  case ":${PATH}:" in
    *":$_bin_dir:"*) ;;  # already present
    *) PATH="$_bin_dir:$PATH" ;;
  esac
done
export PATH
# Log any still-missing critical binaries so failures are diagnosable
for _bin in gh tmux git node; do
  if ! command -v "$_bin" >/dev/null 2>&1; then
    echo "WARNING: launchd-launcher: '$_bin' not found in PATH=$PATH" >&2
  fi
done

# Restore plist-provided ANTHROPIC_BASE_URL if shell profile overwrote it with a stale localhost.
# Only acts when the plist provided a valid non-localhost endpoint that was overwritten.
# If no plist endpoint exists, a shell-provided localhost value may be intentional (e.g., a
# local Anthropic-compatible proxy) and must not be removed.
_shell_base_url="${ANTHROPIC_BASE_URL:-}"
if [[ "$_shell_base_url" == http://localhost* || "$_shell_base_url" == http://127.0.0.1* ]]; then
  if [[ -n "$_plist_base_url" && "$_plist_base_url" != http://localhost* && "$_plist_base_url" != http://127.0.0.1* ]]; then
    # Plist had a valid non-localhost endpoint; restore it over the stale shell value.
    ANTHROPIC_BASE_URL="$_plist_base_url"
    export ANTHROPIC_BASE_URL
  fi
  # No valid plist endpoint: leave shell localhost value intact (may be an intentional proxy).
fi

exec "$TARGET" "$@"
