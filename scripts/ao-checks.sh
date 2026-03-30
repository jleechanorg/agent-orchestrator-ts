#!/bin/bash
# Shared check/fix functions for ao-doctor.sh and setup.sh.
# Source this file:  source "$(dirname "$0")/ao-checks.sh"
# Sets FIX_MODE=true when --fix is passed; reads it as a global.

# ── counters ──────────────────────────────────────────────────────────────────
PASS_COUNT="${PASS_COUNT:-0}"
WARN_COUNT="${WARN_COUNT:-0}"
FAIL_COUNT="${FAIL_COUNT:-0}"
FIX_COUNT="${FIX_COUNT:-0}"

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL %s\n' "$1"
}

fixed() {
  FIX_COUNT=$((FIX_COUNT + 1))
  printf 'FIXED %s\n' "$1"
}

# ── path helpers ──────────────────────────────────────────────────────────────
REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEFAULT_CONFIG_HOME="${HOME:-$REPO_ROOT}"

expand_home() {
  case "$1" in
    "~/"*) printf '%s/%s' "$DEFAULT_CONFIG_HOME" "${1#\~/}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

find_config() {
  if [ -n "${AO_CONFIG_PATH:-}" ] && [ -f "$AO_CONFIG_PATH" ]; then
    printf '%s\n' "$AO_CONFIG_PATH"; return 0
  fi
  local current_dir="$PWD"
  while [ "$current_dir" != "/" ]; do
    [ -f "$current_dir/agent-orchestrator.yaml" ] && { printf '%s\n' "$current_dir/agent-orchestrator.yaml"; return 0; }
    [ -f "$current_dir/agent-orchestrator.yml" ]  && { printf '%s\n' "$current_dir/agent-orchestrator.yml";  return 0; }
    current_dir="$(dirname "$current_dir")"
  done
  [ -f "$REPO_ROOT/agent-orchestrator.yaml" ]     && { printf '%s\n' "$REPO_ROOT/agent-orchestrator.yaml"; return 0; }
  [ -f "$DEFAULT_CONFIG_HOME/.agent-orchestrator.yaml" ] && { printf '%s\n' "$DEFAULT_CONFIG_HOME/.agent-orchestrator.yaml"; return 0; }
  return 1
}

read_config_value() {
  local key="$1" file="$2" raw value
  raw="$(grep -E "^[[:space:]]*${key}:" "$file" | head -n 1 | cut -d: -f2- || true)"
  raw="${raw%%[[:space:]]#*}"
  value="$(printf '%s' "$raw" | tr -d '"' | xargs 2>/dev/null || true)"
  printf '%s' "$value"
}

ensure_dir() {
  local dir_path="$1" label="$2" fix_hint="$3"
  if [ -d "$dir_path" ]; then
    pass "$label exists at $dir_path"
    return 0
  fi
  if [ "${FIX_MODE:-false}" = true ]; then
    if mkdir -p "$dir_path"; then
      fixed "$label created at $dir_path"
      return 0
    fi
    fail "$label could not be created at $dir_path. Fix: $fix_hint"
    return 1
  fi
  warn "$label is missing at $dir_path. Fix: $fix_hint"
}

# ── individual checks ─────────────────────────────────────────────────────────

check_command() {
  local name="$1" required="$2" fix_hint="$3" command_path
  command_path="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$command_path" ]; then
    if [ "$required" = "required" ]; then
      fail "$name is not in PATH. Fix: $fix_hint"
    else
      warn "$name is not in PATH. Fix: $fix_hint"
    fi
    return 1
  fi
  pass "$name resolves to $command_path"
  return 0
}

check_node() {
  if ! check_command "node" "required" "install Node.js 20+ and reopen your shell"; then return; fi
  local version major
  version="$(node --version 2>/dev/null || true)"
  major="${version#v}"; major="${major%%.*}"
  if [ -z "$major" ] || [ "$major" -lt 20 ]; then
    fail "Node.js 20+ is required, found ${version:-unknown}. Fix: install Node.js 20+"
    return
  fi
  pass "Node.js version ${version} is supported"
}

check_git() {
  if ! check_command "git" "required" "install git 2.25+ and reopen your shell"; then return; fi
  local version major minor
  version="$(git --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1)"
  major="${version%%.*}"; minor="${version#*.}"; minor="${minor%%.*}"
  if [ -z "$version" ] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 25 ]; }; then
    fail "git 2.25+ is required, found ${version:-unknown}. Fix: upgrade git"
    return
  fi
  pass "git version ${version} supports worktrees"
}

check_pnpm() {
  if ! check_command "pnpm" "required" "enable corepack or run npm install -g pnpm"; then return; fi
  local version
  version="$(pnpm --version 2>/dev/null || true)"
  pass "pnpm version ${version:-unknown} is available"
}

check_launcher() {
  local ao_path
  ao_path="$(command -v ao 2>/dev/null || true)"
  if [ -n "$ao_path" ]; then
    pass "ao launcher resolves to $ao_path"
    return
  fi
  if [ "${FIX_MODE:-false}" = true ] && command -v npm >/dev/null 2>&1 && [ -d "$REPO_ROOT/packages/cli" ]; then
    if (cd "$REPO_ROOT/packages/cli" && npm link >/dev/null 2>&1) && command -v ao >/dev/null 2>&1; then
      fixed "ao launcher refreshed with npm link"
      return
    fi
    if [ -t 0 ]; then
      printf '  Permission denied. Retrying with sudo...\n'
      if (cd "$REPO_ROOT/packages/cli" && sudo npm link >/dev/null 2>&1) && command -v ao >/dev/null 2>&1; then
        fixed "ao launcher refreshed with sudo npm link"
        return
      fi
    fi
    warn "ao launcher refresh failed. Fix: cd $REPO_ROOT/packages/cli && sudo npm link"
    return
  fi
  warn "ao launcher is not in PATH. Fix: cd $REPO_ROOT && bash scripts/setup.sh"
}

check_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    warn "tmux is not installed. Fix: install tmux for the default runtime"
    return
  fi
  if tmux -V >/dev/null 2>&1 && tmux start-server >/dev/null 2>&1; then
    pass "tmux is installed and the server can start"
    return
  fi
  warn "tmux is installed but failed a basic server health check. Fix: restart tmux or reinstall it"
}

check_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    warn "GitHub CLI is not installed. Fix: install gh from https://cli.github.com/"
    return
  fi
  if gh auth status >/dev/null 2>&1; then
    pass "gh is installed and authenticated"
    return
  fi
  warn "gh is installed but not authenticated. Fix: run gh auth login"
}

check_install_layout() {
  if [ -d "$REPO_ROOT/node_modules" ]; then
    pass "dependencies are installed at $REPO_ROOT/node_modules"
  else
    fail "dependencies are missing at $REPO_ROOT/node_modules. Fix: run pnpm install"
  fi
  if [ -f "$REPO_ROOT/packages/core/dist/index.js" ] || \
     [ -f "$REPO_ROOT/node_modules/@jleechanorg/ao-core/dist/index.js" ]; then
    pass "core package is built"
  else
    fail "core package is not built. Fix: run pnpm --filter @jleechanorg/ao-core build"
  fi
  if [ -f "$REPO_ROOT/packages/cli/dist/index.js" ] || \
     [ -f "$REPO_ROOT/dist/index.js" ]; then
    pass "CLI package is built"
  else
    fail "CLI package is not built. Fix: run pnpm --filter @jleechanorg/ao-cli build"
  fi
}

check_runtime_sanity() {
  local launcher=""
  if [ -f "$REPO_ROOT/packages/ao/bin/ao.js" ]; then
    launcher="$REPO_ROOT/packages/ao/bin/ao.js"
  elif [ -f "$REPO_ROOT/packages/agent-orchestrator/bin/ao.js" ]; then
    launcher="$REPO_ROOT/packages/agent-orchestrator/bin/ao.js"
  elif [ -f "$REPO_ROOT/dist/index.js" ]; then
    launcher="$REPO_ROOT/dist/index.js"
  fi
  if [ -z "$launcher" ]; then
    fail "launcher entrypoint is missing. Fix: reinstall with npm install -g @jleechanorg/ao-cli"
    return
  fi
  if node "$launcher" --version >/dev/null 2>&1; then
    pass "launcher runtime sanity check passed (ao --version)"
  else
    fail "launcher runtime sanity check failed. Fix: run pnpm build and refresh the launcher"
  fi
}

check_config_dirs() {
  local config_path data_dir worktree_dir
  config_path="$(find_config || true)"
  if [ -z "$config_path" ]; then
    warn "No agent-orchestrator config was found. Fix: run ao init --auto in a target repo"
    return
  fi
  pass "config found at $config_path"
  data_dir="$(read_config_value dataDir "$config_path")"
  worktree_dir="$(read_config_value worktreeDir "$config_path")"
  [ -z "$data_dir" ]    && data_dir="$DEFAULT_CONFIG_HOME/.agent-orchestrator"
  [ -z "$worktree_dir" ] && worktree_dir="$DEFAULT_CONFIG_HOME/.worktrees"
  data_dir="$(expand_home "$data_dir")"
  worktree_dir="$(expand_home "$worktree_dir")"
  ensure_dir "$data_dir" "metadata directory" "mkdir -p $data_dir"
  ensure_dir "$worktree_dir" "worktree directory" "mkdir -p $worktree_dir"
}

check_stale_temp_files() {
  local temp_root stale_count deleted_count
  temp_root="${AO_DOCTOR_TMP_ROOT:-${TMPDIR:-/tmp}/agent-orchestrator}"
  if [ ! -d "$temp_root" ]; then
    pass "temp root exists check skipped because $temp_root does not exist"
    return
  fi
  stale_count="$(find "$temp_root" -maxdepth 1 -type f -mmin +60 \( -name 'ao-*.tmp' -o -name 'ao-*.pid' -o -name 'ao-*.lock' \) | wc -l | tr -d ' ')"
  if [ "$stale_count" = "0" ]; then
    pass "no stale temp files were detected under $temp_root"
    return
  fi
  if [ "${FIX_MODE:-false}" = true ]; then
    deleted_count="$(find "$temp_root" -maxdepth 1 -type f -mmin +60 \( -name 'ao-*.tmp' -o -name 'ao-*.pid' -o -name 'ao-*.lock' \) -delete -print | wc -l | tr -d ' ')"
    if [ "$deleted_count" = "$stale_count" ]; then
      fixed "$deleted_count stale temp files removed from $temp_root"
      return
    fi
    warn "Only removed $deleted_count of $stale_count stale temp files from $temp_root. Fix: inspect that directory manually"
    return
  fi
  warn "$stale_count stale temp files older than 60 minutes found under $temp_root. Fix: rerun ao doctor --fix"
}

check_lifecycle_workers() {
  local config_file="$HOME/.openclaw/agent-orchestrator.yaml"
  local canonical_binary canonical_real
  canonical_binary="$(command -v ao 2>/dev/null || printf '%s' "$HOME/bin/ao")"
  canonical_real="$(realpath "$canonical_binary" 2>/dev/null || printf '%s' "$canonical_binary")"

  local all_workers total_count
  all_workers="$(ps aux 2>/dev/null | grep -v grep | grep 'lifecycle-worker ' || true)"
  total_count="$(printf '%s\n' "$all_workers" | grep 'lifecycle-worker' | wc -l | tr -d ' ')"
  total_count="${total_count:-0}"

  if [ "$total_count" -gt 0 ]; then
    local stale_count=0 stale_pids=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local cmd pid
      cmd="$(printf '%s' "$line" | awk '{for(i=1;i<=NF;i++) if($i ~ /\/ao$/) {print $i; exit}}')"
      if [ -z "$cmd" ] || { [ "$cmd" != "${canonical_binary}" ] && [ "$cmd" != "${canonical_real}" ]; }; then
        stale_count=$((stale_count + 1))
        pid="$(echo "$line" | awk '{print $2}')"
        stale_pids="$stale_pids $pid"
        warn "non-canonical lifecycle-worker binary detected: PID=$pid"
      fi
    done <<< "$all_workers"

    if [ "$stale_count" -gt 0 ]; then
      if [ "${FIX_MODE:-false}" = true ]; then
        for pid in $stale_pids; do
          kill "$pid" 2>/dev/null && fixed "killed non-canonical lifecycle-worker PID=$pid" || warn "failed to kill PID=$pid"
        done
      else
        warn "$stale_count non-canonical lifecycle-worker(s) running. Fix: run 'ao doctor --fix' to kill them. PIDs:$stale_pids"
      fi
    else
      pass "all lifecycle-workers using canonical binary ($canonical_binary)"
    fi
  fi

  if [ "$total_count" -gt 3 ]; then
    warn "unusually high lifecycle-worker count: $total_count (expected ≤3). This drains GraphQL quota rapidly."
  elif [ "$total_count" -gt 0 ]; then
    pass "total lifecycle-worker count is $total_count (within normal range)"
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
    pass "no projects in config — per-project lifecycle-worker check skipped"
    return
  fi

  local duplicates_found=0
  for proj in $projects; do
    local count
    count="$(ps aux 2>/dev/null | grep -v grep | grep -E -w "lifecycle-worker[[:space:]].*$proj($|[[:space:]])" | wc -l | tr -d ' ')"
    if [ "$count" -eq 0 ]; then
      warn "no lifecycle-worker process found for project '$proj'"
    elif [ "$count" -ge 2 ]; then
      warn "duplicate lifecycle-worker processes detected for project '$proj': count=$count"
      duplicates_found=$((duplicates_found + 1))
    else
      pass "lifecycle-worker for project '$proj' is running normally (count=$count)"
    fi
  done

  if [ "$duplicates_found" -gt 0 ]; then
    warn "$duplicates_found project(s) have duplicate lifecycle-worker processes. Fix: identify PIDs with 'ps aux | grep lifecycle-worker' and kill duplicate PIDs manually"
  fi
}

# ── ported from PR #294 feat/runner-watchdog-doctor ────────────────────────────

# normalize_repo_url normalizes a git URL to owner/repo form.
# Handles: https://github.com/owner/repo, git@github.com:owner/repo.git, etc.
normalize_repo_url() {
  local url="$1"
  # Strip trailing .git and trailing slashes
  url="${url%.git}"; url="${url%/}"
  # git@github.com:owner/repo → owner/repo
  if [[ "$url" =~ ^git@[^:]+:(.+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  # https://github.com/owner/repo → owner/repo
  elif [[ "$url" =~ ^https?://[^/]+/(.+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$url"
  fi
}

check_runners() {
  local ao_runner_d="${HOME}/.ao-runner.d"
  local runner_script_dir="${HOME}/.local/share/ao-runner"

  if ! command -v docker &>/dev/null; then
    warn "docker not found — self-hosted runner check skipped"
    return
  fi
  if ! docker info &>/dev/null 2>&1; then
    warn "docker daemon not running — self-hosted runner check skipped"
    return
  fi

  if [ ! -d "$ao_runner_d" ] || [ -z "$(ls -A "$ao_runner_d" 2>/dev/null)" ]; then
    warn "no runner configs found in $ao_runner_d — self-hosted runners not configured"
    return
  fi

  local start_script="$runner_script_dir/start-runner.sh"

  for repo_dir in "$ao_runner_d"/*/; do
    local env_file="${repo_dir}.env"
    [ -f "$env_file" ] || continue

    local slug owner_repo repo_url runner_count gh_output gh_status
    slug="$(basename "$repo_dir")"

    repo_url="$(grep '^REPO_URL=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')"
    if [ -z "$repo_url" ]; then
      warn "runner config $slug missing REPO_URL — skipping"
      continue
    fi

    owner_repo="$(normalize_repo_url "$repo_url")"

    if ! command -v gh &>/dev/null; then
      warn "gh not found — runner count check skipped for $slug"
    else
      gh_output="$(gh api "repos/$owner_repo/actions/runners" --jq '.total_count' 2>&1)"
      gh_status=$?
      if [ $gh_status -ne 0 ]; then
        warn "gh api failed for $owner_repo (exit $gh_status): ${gh_output%%$'\n'*}"
      else
        runner_count="$gh_output"
      fi
    fi

    if [ -n "$runner_count" ] && [ "$runner_count" -gt 0 ]; then
      pass "$runner_count runner(s) online for $owner_repo"
    else
      if [ "${FIX_MODE:-false}" = true ]; then
        if [ -x "$start_script" ]; then
          if RUNNER_ENV_FILE="$env_file" "$start_script" >/dev/null 2>&1; then
            fixed "restarted runners for $owner_repo (were offline)"
          else
            fail "failed to restart runners for $owner_repo — check $start_script"
          fi
        else
          fail "0 runners online for $owner_repo — start script not found at $start_script"
        fi
      else
        fail "0 runners online for $owner_repo (config: $slug). Fix: ao doctor --fix"
      fi
    fi
  done
}

# ── new operational checks ─────────────────────────────────────────────────────

# check_launchd_services verifies lifecycle-worker launchd plists are registered
# and the service is running. --fix bootstraps the plist.
check_launchd_services() {
  local plist_label="com.agentorchestrator.lifecycle-agent-orchestrator"
  local plist_path="$HOME/Library/LaunchAgents/${plist_label}.plist"
  local uid
  uid="$(id -u 2>/dev/null || true)"

  if [ -z "$uid" ]; then
    warn "cannot determine user ID — launchd check skipped"
    return
  fi

  # Check if the plist file exists
  if [ ! -f "$plist_path" ]; then
    if [ "${FIX_MODE:-false}" = true ]; then
      warn "launchd plist $plist_path not found — cannot bootstrap. Fix: create the plist first"
    else
      warn "launchd plist $plist_path not found. Fix: run ao doctor --fix to bootstrap"
    fi
    return
  fi

  # Check if the service is currently loaded and running
  local launchd_state
  launchd_state="$(launchctl print "gui/${uid}/${plist_label}" 2>&1 || true)"

  if echo "$launchd_state" | grep -q "state = running"; then
    pass "lifecycle-worker launchd service is running"
    return
  fi

  if [ "${FIX_MODE:-false}" = true ]; then
    if launchctl bootstrap "gui/${uid}" "$plist_path" 2>&1; then
      fixed "lifecycle-worker launchd service bootstrapped and started"
    else
      fail "failed to bootstrap lifecycle-worker launchd service. Fix: manually run launchctl bootstrap gui/${uid} $plist_path"
    fi
    return
  fi

  warn "lifecycle-worker launchd service is not running. Fix: ao doctor --fix"
}

# check_main_repo_branch verifies the main agent-orchestrator clone is on main.
check_main_repo_branch() {
  local main_repo="${AO_MAIN_REPO:-$HOME/project_agento/agent-orchestrator}"
  if [ ! -d "$main_repo/.git" ]; then
    warn "main repo not found at $main_repo — main-repo-branch check skipped"
    return
  fi

  local current_branch
  current_branch="$(git -C "$main_repo" branch --show-current 2>/dev/null || true)"

  if [ "$current_branch" = "main" ]; then
    pass "main repo is on main branch"
    return
  fi

  if [ "${FIX_MODE:-false}" = true ]; then
    if git -C "$main_repo" checkout main 2>&1 && git -C "$main_repo" pull --ff-only 2>&1; then
      fixed "main repo switched from '$current_branch' to main"
    else
      fail "failed to switch main repo to main. Fix: manually cd $main_repo && git checkout main && git pull"
    fi
    return
  fi

  warn "main repo is on branch '$current_branch' (expected: main). Fix: ao doctor --fix"
}

# check_ghost_worktrees detects orphan AO worktrees with no live tmux session.
# Only targets AO-managed names matching ^(ao|jc|wa|cc|ra|wc)-[0-9]+$.
# NEVER removes human-created worktrees.
check_ghost_worktrees() {
  local main_repo="${AO_MAIN_REPO:-$HOME/project_agento/agent-orchestrator}"
  if [ ! -d "$main_repo/.git" ]; then
    warn "main repo not found — ghost-worktree check skipped"
    return
  fi

  local worktrees ghost_count=0
  worktrees="$(git -C "$main_repo" worktree list --porcelain 2>/dev/null || true)"

  # AO-managed worktree names only
  local pattern='^(ao|jc|wa|cc|ra|wc)-[0-9]+$'
  local removed_count=0

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [[ "$line" =~ ^worktree\ (.+)$ ]]; then
      local wt_path="${BASH_REMATCH[1]}"
      local wt_name
      wt_name="$(basename "$wt_path")"
      if [[ "$wt_name" =~ $pattern ]]; then
        # Check if tmux session exists for this worktree
        local session_name="${wt_name}"
        if ! tmux has-session -t "$session_name" 2>/dev/null; then
          # Ghost worktree: AO-named but no live session
          if [ "${FIX_MODE:-false}" = true ]; then
            if git -C "$main_repo" worktree remove --force "$wt_path" 2>/dev/null; then
              removed_count=$((removed_count + 1))
              fixed "removed ghost worktree $wt_path"
            else
              warn "failed to remove ghost worktree $wt_path"
            fi
          else
            ghost_count=$((ghost_count + 1))
            warn "ghost AO worktree detected (no live session): $wt_path. Fix: ao doctor --fix"
          fi
        fi
      fi
    fi
  done <<< "$worktrees"

  if [ "$ghost_count" -eq 0 ] && [ "${FIX_MODE:-false}" = false ]; then
    pass "no ghost AO worktrees detected"
  fi
}

# check_rate_limits warns if GitHub API rate limits are running low.
check_rate_limits() {
  if ! command -v gh >/dev/null 2>&1; then
    warn "gh not installed — rate-limit check skipped"
    return
  fi
  if ! gh auth status >/dev/null 2>&1; then
    warn "gh not authenticated — rate-limit check skipped"
    return
  fi

  local gql_remaining core_remaining
  gql_remaining="$(gh api rate_limit --jq '.resources.graphql.remaining' 2>/dev/null || echo "-1")"
  core_remaining="$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo "-1")"

  if [ "$gql_remaining" -ge 0 ] && [ "$gql_remaining" -lt 200 ]; then
    warn "GraphQL rate limit low: ${gql_remaining} remaining. Defer non-critical GraphQL operations."
  elif [ "$gql_remaining" -ge 0 ]; then
    pass "GraphQL rate limit: ${gql_remaining} remaining"
  fi

  if [ "$core_remaining" -ge 0 ] && [ "$core_remaining" -lt 500 ]; then
    warn "REST API rate limit low: ${core_remaining} remaining. Defer non-critical REST operations."
  elif [ "$core_remaining" -ge 0 ]; then
    pass "REST API rate limit: ${core_remaining} remaining"
  fi
}

# check_skeptic_chain verifies the skeptic CLI chain is functional.
check_skeptic_chain() {
  if ! command -v ao >/dev/null 2>&1; then
    warn "ao not in PATH — skeptic chain check skipped"
    return
  fi
  if ao skeptic verify --help >/dev/null 2>&1; then
    pass "ao skeptic verify --help runs successfully"
  else
    warn "ao skeptic verify --help failed. Fix: rebuild ao CLI (pnpm build)"
  fi
}
