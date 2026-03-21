#!/bin/bash

set -euo pipefail

SKIP_SMOKE=false
SMOKE_ONLY=false
TARGET_BRANCH="${AO_UPDATE_BRANCH:-main}"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-smoke)
      SKIP_SMOKE=true
      ;;
    --smoke-only)
      SMOKE_ONLY=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ao update [--skip-smoke] [--smoke-only]

Fast-forwards the local Agent Orchestrator install repo to main, installs deps,
clean-rebuilds critical packages, refreshes the ao launcher, and runs smoke tests.

Options:
  --skip-smoke  Skip smoke tests after rebuild
  --smoke-only  Run smoke tests without fetching or rebuilding
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

if [ "$SKIP_SMOKE" = true ] && [ "$SMOKE_ONLY" = true ]; then
  printf 'Conflicting options: use either --skip-smoke or --smoke-only, not both.\n' >&2
  exit 1
fi

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

require_command() {
  local name="$1"
  local fix_hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Fix: %s\n' "$name" "$fix_hint" >&2
    exit 1
  fi
}

run_cmd() {
  printf -- '-> %s\n' "$*"
  "$@"
}

run_smoke_tests() {
  printf '\nRunning smoke tests...\n'
  run_cmd node "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" --version
  run_cmd node "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" doctor --help
  run_cmd node "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" update --help
}

ensure_repo_clean() {
  local reason="$1"
  local status_output
  status_output="$(git status --porcelain)"
  if [ -n "$status_output" ]; then
    printf '%s\n' "$reason" >&2
    exit 1
  fi
}

ensure_on_target_branch() {
  local current_branch
  current_branch="$(git branch --show-current)"
  if [ "$current_branch" != "$TARGET_BRANCH" ]; then
    printf 'Current branch is %s, expected %s. Fix: git switch %s && rerun ao update.\n' \
      "$current_branch" "$TARGET_BRANCH" "$TARGET_BRANCH" >&2
    exit 1
  fi
}

printf 'Agent Orchestrator Update\n\n'

require_command node "install Node.js 20+"

# ─── Kill existing lifecycle-workers for all projects ───────────────────────
# Read project IDs from the canonical config so we can stop workers before
# reinstalling. We do this before rebuilding so the new binary is never
# left in a state where an old worker is holding stale state.
kill_existing_workers() {
  local config_file="$HOME/.openclaw/agent-orchestrator.yaml"
  if [ ! -f "$config_file" ]; then
    printf 'No canonical config at %s — skipping worker teardown.\n' "$config_file"
    return 0
  fi

  local projects
  projects="$(python3 -c "
import yaml, sys
try:
    with open('$config_file') as f:
        cfg = yaml.safe_load(f)
    for pid in cfg.get('projects', {}):
        print(pid)
except Exception:
    pass
" 2>/dev/null || true)"

  if [ -z "$projects" ]; then
    printf 'No projects found in config — skipping worker teardown.\n'
    return 0
  fi

  printf '\nTearing down lifecycle-workers before update...\n'
  for proj in $projects; do
    local pid_file="$HOME/.agent-orchestrator/$(echo -n "$HOME/.openclaw" | sha256sum | cut -d' ' -f1)/$proj/lifecycle-worker.pid"
    # Also check launchd
    local plist_name="com.agentorchestrator.lifecycle-${proj}"
    if launchctl list "$plist_name" 2>/dev/null | grep -q "PID"; then
      printf '  -> Unloading launchd agent %s\n' "$plist_name"
      launchctl unload "$HOME/Library/LaunchAgents/${plist_name}.plist" 2>/dev/null || true
    fi
    # Also kill by PID file
    if [ -f "$pid_file" ]; then
      local lw_pid
      lw_pid="$(cat "$pid_file" 2>/dev/null)"
      if [ -n "$lw_pid" ] && kill -0 "$lw_pid" 2>/dev/null; then
        printf '  -> Killing lifecycle-worker for project %s (PID %s)\n' "$proj" "$lw_pid"
        kill "$lw_pid" 2>/dev/null || true
      fi
    fi
  done
  printf 'Worker teardown complete.\n'
}

restart_workers() {
  local config_file="$HOME/.openclaw/agent-orchestrator.yaml"
  if [ ! -f "$config_file" ]; then
    printf 'No canonical config — skipping worker restart.\n'
    return 0
  fi

  local projects
  projects="$(python3 -c "
import yaml, sys
try:
    with open('$config_file') as f:
        cfg = yaml.safe_load(f)
    for pid in cfg.get('projects', {}):
        print(pid)
except Exception:
    pass
" 2>/dev/null || true)"

  if [ -z "$projects" ]; then
    return 0
  fi

  local ao_bin
  ao_bin="$(command -v ao 2>/dev/null || true)"
  if [ -z "$ao_bin" ]; then
    printf 'ao binary not found in PATH — skipping worker restart.\n'
    return 0
  fi

  printf '\nRestarting lifecycle-workers after update...\n'
  for proj in $projects; do
    printf '  -> Starting lifecycle-worker for project %s\n' "$proj"
    "$ao_bin" lifecycle-worker "$proj" &
  done
  printf 'Worker restart complete.\n'
}

cd "$REPO_ROOT"

if [ "$SMOKE_ONLY" = false ]; then
  require_command git "install git 2.25+"
  require_command pnpm "enable corepack or run npm install -g pnpm"
  require_command npm "install npm with Node.js"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'The update command must run inside the Agent Orchestrator git checkout.\n' >&2
    exit 1
  fi

  ensure_repo_clean "Working tree is dirty. Fix: commit or stash local changes before running ao update."
  ensure_on_target_branch

  kill_existing_workers

  run_cmd git fetch origin "$TARGET_BRANCH"
  run_cmd git pull --ff-only origin "$TARGET_BRANCH"
  run_cmd pnpm install

  run_cmd pnpm --filter @jleechanorg/ao-core clean
  run_cmd pnpm --filter @jleechanorg/ao-cli clean
  run_cmd pnpm --filter @jleechanorg/ao-web clean

  run_cmd pnpm --filter @jleechanorg/ao-core build
  run_cmd pnpm --filter @jleechanorg/ao-cli build
  run_cmd pnpm --filter @jleechanorg/ao-web build

  printf '\nRefreshing ao launcher...\n'
  (
    cd "$REPO_ROOT/packages/cli"
    if npm link 2>/dev/null; then
      :
    elif [ -t 0 ]; then
      printf '  Permission denied. Retrying with sudo...\n'
      sudo npm link
    else
      printf 'ERROR: Permission denied. Run manually: cd %s/packages/cli && sudo npm link\n' "$REPO_ROOT"
      exit 1
    fi
  )

  ensure_repo_clean "Update modified tracked files. Inspect git status, review the changes, and rerun after restoring a clean checkout if needed."

  restart_workers
fi

if [ "$SKIP_SMOKE" = false ]; then
  run_smoke_tests
fi

printf '\nUpdate complete.\n'
