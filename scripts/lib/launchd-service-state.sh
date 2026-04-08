#!/bin/bash

# Shared launchd state parsing helpers for shell harness scripts.
# These intentionally stay POSIX-ish so launchd jobs do not depend on Node/TS.

extract_launchctl_state_from_output() {
  local output="${1-}"
  local state
  state="$(printf '%s\n' "$output" | sed -n 's/^[[:space:]]*state = //p' | head -n 1 | tr -d '\r')"

  if [ -n "$state" ]; then
    printf '%s' "$state"
    return 0
  fi

  if printf '%s\n' "$output" | grep -q "Could not find service"; then
    printf 'not_found'
    return 0
  fi

  if printf '%s\n' "$output" | grep -q "^Bad request\\.$"; then
    printf 'bad_request'
    return 0
  fi

  printf 'unknown'
}

classify_launchctl_state() {
  local state="${1-}"
  case "$state" in
    running)
      printf 'running'
      ;;
    "not running")
      printf 'not_running'
      ;;
    waiting)
      printf 'waiting'
      ;;
    *spawn*)
      printf 'spawn_pending'
      ;;
    not_found|bad_request)
      printf 'not_found'
      ;;
    *)
      printf 'unknown'
      ;;
  esac
}
