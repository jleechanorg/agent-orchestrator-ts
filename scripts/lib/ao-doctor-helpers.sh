#!/usr/bin/env bash
# ao-doctor-helpers.sh — pure helpers sourced by scripts/ao-doctor.sh
# and scripts/test-doctor-lifecycle-cmdline.sh. Keeping these in a
# library makes the per-project lifecycle check testable without
# launching real orchestrators or relying on the host's process list.
#
# NO side effects on source. All functions are pure or take their input
# as arguments (no reads of $HOME, $PATH, $PS_OUTPUT, etc.).
#
# Mirrors the pure-helper pattern of scripts/lib/ao-health-helpers.sh.

# Escape a string for use in an ERE (extended regular expression).
# Required before interpolating a project name into a regex — project
# names like "my.project.v2" contain regex metacharacters ('.').
escape_ere() { printf '%s' "$1" | sed 's/[][().*^$+?{}|\\]/\\&/g'; }

# Returns 0 if the cmdline references the given project as the immediate
# argument of `start` (in-process orchestrator shape introduced by the
# in-process lifecycle refactor — see
# packages/cli/src/lib/lifecycle-service.ts:1-25) or `lifecycle-worker`
# (legacy subprocess shape, deleted by PR #712 but still found in old
# launches). Pure — does NOT validate the binary path; the caller can
# layer that on top via command_matches_ao_binary from
# scripts/lib/ao-health-helpers.sh if needed.
#
# Args:
#   $1 — full command line (one ps aux row, e.g. "... node dist/index.js start agent-orchestrator --no-dashboard")
#   $2 — project id (will be regex-escaped before matching)
# Returns: 0 if the cmdline is an orchestrator for $2, 1 otherwise.
cmdline_references_project() {
  local cmdline="$1"
  local proj="$2"
  local escaped_proj
  escaped_proj="$(escape_ere "$proj")"
  # Legacy: `lifecycle-worker <proj>` with proj as the immediate next
  # whitespace-delimited token. Both the leading (^|[[:space:]]) guard
  # (prevents matches on doc filenames like "diagnose-lifecycle-worker.md")
  # AND the trailing ([[:space:]]|$) boundary are required — without the
  # trailing boundary, a project like "api" would spuriously match
  # `lifecycle-worker my-api` (any suffix token containing the project id).
  # Mirrors the in-process shape below and the canonical pattern in
  # scripts/ao-health.sh:138
  #   pgrep -f "start[[:space:]]($PROJECT_ALT)([[:space:]]|$)"
  if printf '%s\n' "$cmdline" \
      | grep -E -q "(^|[[:space:]])lifecycle-worker[[:space:]]+${escaped_proj}([[:space:]]|$)"; then
    return 0
  fi
  # In-process: `start <proj>` as a whole-word token. The leading
  # (^|[[:space:]]) guard prevents false matches on tokens that END in
  # `start` (e.g., `restart <proj>`, `systemctl start <proj>`,
  # `quickstart <proj>` — only the latter two would still match because
  # they contain `start` at the end of a non-space-prefixed token; the
  # guard eliminates the `restart` case).
  if printf '%s\n' "$cmdline" \
      | grep -E -q "(^|[[:space:]])start[[:space:]]+${escaped_proj}([[:space:]]|$)"; then
    return 0
  fi
  return 1
}

# Count orchestrator processes managing the given project from a ps aux
# snapshot. The snapshot is a newline-separated list of ps aux rows
# (one row per process). Pure — does NOT call ps itself; the caller
# captures the snapshot via `ps aux` (or a mock for tests) and passes it
# in.
#
# Recognizes BOTH:
#   - legacy `lifecycle-worker <proj>` subprocess shape
#   - in-process `start <proj>` orchestrator shape
#
# This is the canonical fix for the false-positive WARN introduced by
# the per-project check in scripts/ao-doctor.sh after PR #712 deleted
# the `lifecycle-worker` CLI in favor of in-process polling. Without
# accepting the `start <proj>` shape, every configured project emits
# `WARN: no lifecycle-worker process found for project 'X'` even when
# the in-process orchestrator is healthy.
#
# Args:
#   $1 — project id
#   $2 — ps aux snapshot (newline-separated rows; "" is acceptable)
# Returns: count of matching orchestrator processes (0 if none)
count_orchestrators_for_project() {
  local proj="$1"
  local ps_snapshot="$2"
  local escaped_proj
  escaped_proj="$(escape_ere "$proj")"
  # Combined alternation: legacy OR in-process. The grep filter
  # requires the project id as the IMMEDIATE whitespace-delimited token
  # after `lifecycle-worker` or `start`, with leading/trailing whitespace
  # boundaries on both sides. Partial matches like "api" inside
  # "lifecycle-worker my-api" or "lifecycle-worker api-v2" are excluded,
  # AND tokens ending in `start` (e.g., `restart <proj>`,
  # `quickstart <proj>`) cannot match because the left boundary rejects
  # unprefixed `start`.
  # NOTE: `systemctl start <proj>` is intentionally NOT excluded because
  # the (^|[[:space:]]) left boundary would also match
  # `ao start <project>` (the symlink-wrapper cmdline, where `ao`
  # precedes `start` with whitespace). Tighter guards like
  # [^[:alpha:]] would break the symlink case. If systemd-managed
  # deployments need stricter exclusion, layer it on via
  # `command_matches_ao_binary` from scripts/lib/ao-health-helpers.sh.
  # `|| true` is required: grep returns 1 on no match, and callers that
  # run with `set -o pipefail` would otherwise abort before wc can
  # report the 0 count.
  printf '%s\n' "$ps_snapshot" \
    | grep -E "(^|[[:space:]])lifecycle-worker[[:space:]]+${escaped_proj}([[:space:]]|$)|(^|[[:space:]])start[[:space:]]+${escaped_proj}([[:space:]]|$)" \
    | wc -l | tr -d ' ' \
    || true
}
