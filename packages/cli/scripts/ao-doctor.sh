#!/bin/bash
# Agent Orchestrator Doctor — health-check and fix script.
# Sources shared checks from ao-checks.sh; add new checks there, not here.
# This file is kept in sync with scripts/ao-doctor.sh

set -uo pipefail

# Source ao-checks.sh relative to this script (packages/cli/scripts/) -> ../../../scripts/
_doctor_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_primary="${_doctor_dir}/../../../scripts/ao-checks.sh"
_bundled="${_doctor_dir}/../../scripts/ao-checks.sh"

if [ -f "$_primary" ]; then
  _checks_path="$_primary"
elif [ -f "$_bundled" ]; then
  _checks_path="$_bundled"
else
  printf 'ERROR: ao-checks.sh not found (tried %s and %s)
' "$_primary" "$_bundled" >&2
  exit 1
fi
# shellcheck source=../../../scripts/ao-checks.sh
source "$_checks_path"

# ── argument parsing ───────────────────────────────────────────────────────────
FIX_MODE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --fix) FIX_MODE=true ;;
    -h|--help)
      cat <<'EOF'
Usage: ao doctor [--fix]

Checks install, PATH, binaries, service health, stale temp files, and runtime sanity.
Runs all checks from ao-checks.sh plus:
  check_runners           self-hosted runner status
  check_launchd_services  launchd lifecycle-worker
  check_main_repo_branch  main repo on main
  check_ghost_worktrees   orphan AO worktrees
  check_rate_limits       GitHub API quotas
  check_skeptic_chain     ao skeptic verify --help

Options:
  --fix    Apply safe fixes for all fixable checks
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

printf 'Agent Orchestrator Doctor\n\n'

# ── standard checks (from ao-checks.sh) ───────────────────────────────────────
check_node
check_git
check_pnpm
check_launcher
check_tmux
check_gh
check_config_dirs
check_stale_temp_files
check_install_layout
check_runtime_sanity
check_lifecycle_workers

# ── PR #294 port: check_runners ───────────────────────────────────────────────
check_runners

# ── new operational checks ───────────────────────────────────────────────────
check_launchd_services
check_main_repo_branch
check_ghost_worktrees
check_rate_limits
check_skeptic_chain

printf '\nResults: %s PASS, %s WARN, %s FAIL, %s FIXED\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$FIX_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf 'Environment needs attention before AO is safe to update or run.\n' >&2
  exit 1
fi

printf 'Environment looks healthy enough to run Agent Orchestrator.\n'
