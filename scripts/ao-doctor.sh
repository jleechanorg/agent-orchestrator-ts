#!/bin/bash
# Agent Orchestrator Doctor — health-check and fix script.
# Sources shared checks from ao-checks.sh; add new checks there, not here.

set -uo pipefail

# Determine script directory (supports both direct execution and sourcing)
_doctor_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source ao-checks.sh relative to this script
# shellcheck source=./ao-checks.sh
source "${_doctor_dir}/ao-checks.sh"

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
  check_runners         — self-hosted runner status
  check_launchd_services — launchd lifecycle-worker
  check_main_repo_branch — main repo on main
  check_ghost_worktrees — orphan AO worktrees
  check_rate_limits     — GitHub API quotas
  check_skeptic_chain   — ao skeptic verify --help

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

# ── new operational checks ─────────────────────────────────────────────────────
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
