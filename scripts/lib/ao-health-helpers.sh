#!/usr/bin/env bash
# ao-health-helpers.sh — pure helpers sourced by scripts/ao-health.sh
# and scripts/test-ao-health.sh. Keeping these in a library makes the bash
# script's behavior testable without launching real orchestrators.
#
# NO side effects on source. All functions are pure or mockable via the
# environment (RESOLVE_PATH_BIN for resolve_path, command_matches_ao_binary
# never invokes external commands other than resolve_path).

# Escape a string for use in an ERE (extended regular expression).
escape_ere() { printf '%s' "$1" | sed 's/[][().*^$+?{}|\\]/\\&/g'; }

# Resolve symlinks — matches setup-launchd.sh behavior so that a worker
# launched via a symlinked binary (e.g. /Users/.../bin/ao -> pnpm shim)
# is correctly recognized by the health job.
resolve_path() {
  python3 - "$1" <<'PY' 2>/dev/null || printf '%s\n' "$1"
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
}

# Check whether a process command line matches this install's AO binary,
# accounting for symlinks and /private prefix on macOS.
# Also resolves the CMD binary itself so that two different symlinks to the
# same real file (e.g. /Users/.../bin/ao -> .nvm/.../bin/ao -> dist/index.js)
# are correctly recognised as the same binary.
command_matches_ao_binary() {
  local cmd="$1"
  local ao_bin="$2"
  local ao_real cmd_bin cmd_real
  ao_real="$(resolve_path "$ao_bin")"
  local ao_alt="${ao_bin#/private}"
  local ao_real_alt="${ao_real#/private}"
  if [[ "$cmd" == *"$ao_bin"* || "$cmd" == *"$ao_alt"* || "$cmd" == *"$ao_real"* || "$cmd" == *"$ao_real_alt"* ]]; then
    return 0
  fi
  cmd_bin=$(echo "$cmd" | grep -oE '(/[^ ]+/ao)( |$)' | head -1 | xargs 2>/dev/null || true)
  if [ -n "$cmd_bin" ]; then
    cmd_real="$(resolve_path "$cmd_bin")"
    [ "$cmd_real" = "$ao_real" ] && return 0
  fi
  return 1
}

# Build the PROJECT_ALT regex alternation from a list of project names.
# Used by both the liveness check and the orphan sweep. Pure function — takes
# the list as $1 (space-separated) and prints the alternation on stdout.
build_project_alt() {
  local projects="$1"
  local alt=""
  for p in $projects; do
    local ep
    ep="$(escape_ere "$p")"
    if [ -z "$alt" ]; then
      alt="$ep"
    else
      alt="$alt|$ep"
    fi
  done
  printf '%s' "$alt"
}

# Build the canonical orchestrator liveness pgrep pattern from PROJECT_ALT.
# Used to confirm both the liveness check and the orphan sweep use the same
# robust pattern.
orchestrator_pgrep_pattern() {
  local alt="$1"
  printf 'start[[:space:]](%s)([[:space:]]|$)' "$alt"
}

# Build the orphan-sweep pgrep pattern — same shape as the liveness pattern
# but WITHOUT the PROJECT_ALT restriction, so the inner grep filter (using
# PROJECT_ALT) can distinguish anchored vs orphan processes.
orchestrator_orphan_sweep_pattern() {
  printf 'start[[:space:]][a-zA-Z0-9_.-]+([[:space:]]|$)'
}

# Check whether a stale running.json should be cleaned up.
# Returns 0 (true) if the PID in running.json is dead and the file should be
# removed; 1 (false) otherwise.
#
# Args:
#   $1 — path to running.json
# Returns: 0 if stale and cleanable, 1 if alive or missing
should_clean_stale_running_json() {
  local running_json="$1"
  [ -f "$running_json" ] || return 1
  local stale_pid
  stale_pid=$(grep -o '"pid":[[:space:]]*[0-9]*' "$running_json" 2>/dev/null | grep -o '[0-9]*' | head -1 || true)
  [ -n "$stale_pid" ] || return 1
  # If the PID is alive, NOT stale.
  if kill -0 "$stale_pid" 2>/dev/null; then
    return 1
  fi
  return 0
}