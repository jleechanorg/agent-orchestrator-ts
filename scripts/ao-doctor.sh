#!/bin/bash

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEFAULT_CONFIG_HOME="${HOME:-$REPO_ROOT}"
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
FIX_COUNT=0

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

expand_home() {
  case "$1" in
    "~/"*)
      printf '%s/%s' "$DEFAULT_CONFIG_HOME" "${1#\~/}"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

find_config() {
  if [ -n "${AO_CONFIG_PATH:-}" ] && [ -f "$AO_CONFIG_PATH" ]; then
    printf '%s\n' "$AO_CONFIG_PATH"
    return 0
  fi

  local current_dir="$PWD"
  while [ "$current_dir" != "/" ]; do
    if [ -f "$current_dir/agent-orchestrator.yaml" ]; then
      printf '%s\n' "$current_dir/agent-orchestrator.yaml"
      return 0
    fi
    if [ -f "$current_dir/agent-orchestrator.yml" ]; then
      printf '%s\n' "$current_dir/agent-orchestrator.yml"
      return 0
    fi
    current_dir="$(dirname "$current_dir")"
  done

  if [ -f "$REPO_ROOT/agent-orchestrator.yaml" ]; then
    printf '%s\n' "$REPO_ROOT/agent-orchestrator.yaml"
    return 0
  fi

  if [ -f "$DEFAULT_CONFIG_HOME/.agent-orchestrator.yaml" ]; then
    printf '%s\n' "$DEFAULT_CONFIG_HOME/.agent-orchestrator.yaml"
    return 0
  fi

  return 1
}

read_config_value() {
  local key="$1"
  local file="$2"
  local raw
  local value
  raw="$(grep -E "^[[:space:]]*${key}:" "$file" | head -n 1 | cut -d: -f2- || true)"
  raw="${raw%%[[:space:]]#*}"
  value="$(printf '%s' "$raw" | tr -d '"' | xargs 2>/dev/null || true)"
  printf '%s' "$value"
}

ensure_dir() {
  local dir_path="$1"
  local label="$2"
  local fix_hint="$3"
  if [ -d "$dir_path" ]; then
    pass "$label exists at $dir_path"
    return 0
  fi

  if [ "$FIX_MODE" = true ]; then
    if mkdir -p "$dir_path"; then
      fixed "$label created at $dir_path"
      return 0
    fi
    fail "$label could not be created at $dir_path. Fix: $fix_hint"
    return 1
  fi

  warn "$label is missing at $dir_path. Fix: $fix_hint"
}

check_command() {
  local name="$1"
  local required="$2"
  local fix_hint="$3"
  local command_path
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
  if ! check_command "node" "required" "install Node.js 20+ and reopen your shell"; then
    return
  fi
  local version major
  version="$(node --version 2>/dev/null || true)"
  major="${version#v}"
  major="${major%%.*}"
  if [ -z "$major" ] || [ "$major" -lt 20 ]; then
    fail "Node.js 20+ is required, found ${version:-unknown}. Fix: install Node.js 20+"
    return
  fi
  pass "Node.js version ${version} is supported"
}

check_git() {
  if ! check_command "git" "required" "install git 2.25+ and reopen your shell"; then
    return
  fi
  local version major minor
  version="$(git --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1)"
  major="${version%%.*}"
  minor="${version#*.}"
  minor="${minor%%.*}"
  if [ -z "$version" ] || [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 25 ]; }; then
    fail "git 2.25+ is required, found ${version:-unknown}. Fix: upgrade git"
    return
  fi
  pass "git version ${version} supports worktrees"
}

check_pnpm() {
  if ! check_command "pnpm" "required" "enable corepack or run npm install -g pnpm"; then
    return
  fi
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

  if [ "$FIX_MODE" = true ] && command -v npm >/dev/null 2>&1 && [ -d "$REPO_ROOT/packages/cli" ]; then
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

  # Support both git-checkout layout (packages/core/dist) and npm-install layout
  # (node_modules/@jleechanorg/ao-core/dist or sibling dist/ for the CLI itself)
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
  # Support git-checkout layout (packages/ao/bin/ao.js), npm-install layout
  # (dist/index.js inside the CLI package root), and legacy paths.
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

  if [ -z "$data_dir" ]; then
    data_dir="$DEFAULT_CONFIG_HOME/.agent-orchestrator"
  fi
  if [ -z "$worktree_dir" ]; then
    worktree_dir="$DEFAULT_CONFIG_HOME/.worktrees"
  fi

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

  if [ "$FIX_MODE" = true ]; then
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
  # Count lifecycle-worker processes per project via launchd and ps
  local config_file="$HOME/.openclaw/agent-orchestrator.yaml"
  # Resolve canonical ao binary from PATH at runtime rather than hardcoding a path.
  # Also resolve the real path (symlink target) so we match both launchd-spawned
  # workers (show as /path/to/ao) and node-spawned workers (show as node /real/path.js).
  local canonical_binary
  canonical_binary="$(command -v ao 2>/dev/null || printf '%s' "$HOME/bin/ao")"
  local canonical_real
  canonical_real="$(realpath "$canonical_binary" 2>/dev/null || printf '%s' "$canonical_binary")"

  # --- Check 1: detect ALL lifecycle-worker processes, flag non-canonical binaries ---
  # NOTE: Checks 1 and 2 run unconditionally — they do not require the config file.
  # config_file is only needed for Check 3 (per-project duplicate detection).
  local all_workers
  # Use 'lifecycle-worker ' (trailing space) to avoid matching file paths like ao-lifecycle-triage.md or diagnose-lifecycle-worker.md
  all_workers="$(ps aux 2>/dev/null | grep -v grep | grep 'lifecycle-worker ' || true)"
  # Count via wc -l to avoid grep -c exit-code / multiline artefacts
  local total_count
  total_count="$(printf '%s\n' "$all_workers" | grep 'lifecycle-worker' | wc -l | tr -d ' ')"
  total_count="${total_count:-0}"

  if [ "$total_count" -gt 0 ]; then
    # Count workers NOT using the canonical binary
    local stale_count=0
    local stale_pids=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local cmd
      cmd="$(printf '%s' "$line" | awk '{for(i=1;i<=NF;i++) if($i ~ /\/ao$/) {print $i; exit}}')"
      if [ -z "$cmd" ] || { [ "$cmd" != "${canonical_binary}" ] && [ "$cmd" != "${canonical_real}" ]; }; then
        stale_count=$((stale_count + 1))
        local pid
        pid="$(echo "$line" | awk '{print $2}')"
        stale_pids="$stale_pids $pid"
        warn "non-canonical lifecycle-worker binary detected: PID=$pid binary contains: $(echo "$line" | grep -oE '/[^ ]+lifecycle|[^ ]+/ao' | head -1 || echo "unknown")"
      fi
    done <<< "$all_workers"

    if [ "$stale_count" -gt 0 ]; then
      if [ "$FIX_MODE" = true ]; then
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

  # --- Check 2: total worker count sanity (warn if > 3 regardless of binary) ---
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

  # --- Check 3: per-project duplicate detection (original check) ---
  local duplicates_found=0
  for proj in $projects; do
    # Count how many processes appear to be lifecycle-workers for this project
    # via ps (covers both launchd-managed and manual/process-spawned workers).
    # -E + -w: require project ID to match as a whole word (prevents "api"
    # from matching "lifecycle-worker api-v2"). The pattern starts with
    # lifecycle-worker so we don't match unrelated lines containing the proj ID.
    # -v grep filters out the grep processes themselves.
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

FIX_MODE=false

# Guard: return early when sourced (e.g., for unit tests) - after functions are defined
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -uo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    --fix)
      FIX_MODE=true
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ao doctor [--fix]

Checks install, PATH, binaries, service health, stale temp files, and runtime sanity.

Options:
  --fix    Apply safe fixes for missing launcher links, support dirs, stale temp files, and non-canonical lifecycle-workers
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

printf '\nResults: %s PASS, %s WARN, %s FAIL, %s FIXED\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$FIX_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf 'Environment needs attention before AO is safe to update or run.\n' >&2
  exit 1
fi

printf 'Environment looks healthy enough to run Agent Orchestrator.\n'
