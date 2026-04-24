#!/bin/bash
# ao-install.sh — Consolidated AO worker-node install
# Replaces: setup.sh + bootstrap-openclaw-config.sh + setup-extended.sh
# Usage: curl -fsSL https://raw.githubusercontent.com/jleechanorg/agent-orchestrator/main/scripts/ao-install.sh | bash
# Or:     bash /tmp/ao-install.sh  (from a clone of agent-orchestrator)

set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes_prod}"
AGENT_ORCHESTRATOR_REPO="${AGENT_ORCHESTRATOR_REPO:-https://github.com/jleechanorg/agent-orchestrator}"
AGENT_ORCHESTRATOR_BRANCH="${AGENT_ORCHESTRATOR_BRANCH:-main}"
AO_REPO_ROOT="${AO_REPO_ROOT:-$HOME/project_agento/agent-orchestrator}"
PROJECTS="${AO_PROJECTS:-jleechanclaw browserclaw worldarchitect agent-orchestrator ralph claude-commands worldai-claw openclaw-sso mctrl-test mcp-mail worldclaw-dev llm_wiki}"

echo "=== AO Worker Node Install ==="
echo "Hermes home: $HERMES_HOME"
echo "Repo: $AGENT_ORCHESTRATOR_REPO ($AGENT_ORCHESTRATOR_BRANCH)"
echo

# ─── Step 0: Detect run mode ─────────────────────────────────────────────────
# Two modes:
#   MODE=repo    — running from an existing ~/project_agento/agent-orchestrator clone
#   MODE=curl    — piped from curl, need to clone first

if [ -d "$AO_REPO_ROOT/.git" ]; then
  MODE="repo"
  REPO_ROOT="$AO_REPO_ROOT"
  echo "  [$MODE] Repo detected: $REPO_ROOT"
  # Normalize a GitHub URL to https://github.com/owner/repo form for comparison.
  # Handles: git@github.com:..., https://github.com/... (with or without .git suffix),
  # and ssh://git@github.com/... forms.
  normalize_gh_url() {
    printf '%s' "$1" | sed \
      -e 's|git@github.com:|https://github.com/|' \
      -e 's|ssh://git@github.com/|https://github.com/|' \
      -e 's|\.git$||'
  }
  # Validate existing clone matches expected repo/branch
  actual_remote=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")
  expected_normalized=$(normalize_gh_url "$AGENT_ORCHESTRATOR_REPO")
  actual_normalized=$(normalize_gh_url "$actual_remote")
  if [ "$actual_normalized" != "$expected_normalized" ]; then
    echo "ERROR: existing clone remote URL does not match expected."
    echo "  Expected: $AGENT_ORCHESTRATOR_REPO"
    echo "  Actual:   $actual_remote"
    echo "Set AO_FORCE_CLONE=1 to remove and reclone."
    if [ "${AO_FORCE_CLONE:-0}" != "1" ]; then
      exit 1
    fi
    echo "  AO_FORCE_CLONE=1 — removing stale clone..."
    rm -rf "$REPO_ROOT"
  else
    # Sync to expected branch
    if ! git -C "$REPO_ROOT" fetch origin "$AGENT_ORCHESTRATOR_BRANCH" >/dev/null 2>&1; then
      echo "  WARNING: fetch failed (offline?) — using existing checkout"
    fi
    current_branch=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || echo "")
    if [ "$current_branch" != "$AGENT_ORCHESTRATOR_BRANCH" ]; then
      if ! git -C "$REPO_ROOT" checkout "$AGENT_ORCHESTRATOR_BRANCH" >/dev/null 2>&1; then
        echo "  WARNING: checkout to $AGENT_ORCHESTRATOR_BRANCH failed — continuing with $current_branch"
      fi
    fi
    echo "  Repo validated and synced."
  fi
fi

# If directory missing (was removed by AO_FORCE_CLONE), clone fresh
if [ ! -d "$AO_REPO_ROOT/.git" ]; then
  MODE="curl"
  REPO_ROOT="$AO_REPO_ROOT"
  mkdir -p "$(dirname "$REPO_ROOT")"
  echo "  [$MODE] Cloning agent-orchestrator to $REPO_ROOT..."
  git clone --branch "$AGENT_ORCHESTRATOR_BRANCH" \
    "$AGENT_ORCHESTRATOR_REPO" "$REPO_ROOT" >/dev/null 2>&1
fi

SCRIPT_DIR="$REPO_ROOT/scripts"

# ─── Helper: run a command, filter its output, propagate exit status ──────────
# Preserves failures from setup scripts while still filtering noisy output.
run_filter() {
  local limit="$1"
  local pattern="$2"
  shift 2
  local log_file
  log_file="$(mktemp)"
  local status=0
  "$@" >"$log_file" 2>&1 || status=$?
  grep -E "$pattern" "$log_file" | head -"$limit" || true
  rm -f "$log_file"
  return $status
}

# ─── Step 1: Install dependencies + build CLI ────────────────────────────────
echo "[1/7] Running setup.sh (install + build)..."
run_filter 20 '^\[ok\]|\[ERROR\]|ERROR|complete' bash "$SCRIPT_DIR/setup.sh"

# ─── Step 2: Bootstrap config at hermes_prod ─────────────────────────────────
echo "[2/7] Bootstrapping AO config at $HERMES_HOME/agent-orchestrator.yaml..."

mkdir -p "$HERMES_HOME"
CONFIG_FILE="$HERMES_HOME/agent-orchestrator.yaml"

# Preserve existing config unless AO_OVERWRITE is set
if [ -f "$CONFIG_FILE" ] && [ "${AO_OVERWRITE:-0}" != "1" ]; then
  echo "  Existing config found at $CONFIG_FILE"
  echo "  Set AO_OVERWRITE=1 to force overwrite."
else
  # Write canonical config
  cat >"$CONFIG_FILE" <<EOF
# Managed AO config — $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Single source of truth. Do not edit manually for project additions.
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
EOF

  for pid in $PROJECTS; do
    echo "  $pid:" >> "$CONFIG_FILE"
    echo "    path: ~/project_agento/$pid" >> "$CONFIG_FILE"
    echo "    repo: jleechanorg/$pid" >> "$CONFIG_FILE"
    echo "    scm:" >> "$CONFIG_FILE"
    echo "      plugin: github" >> "$CONFIG_FILE"
  done

  chmod 600 "$CONFIG_FILE"
  echo "  Config written: $CONFIG_FILE"
fi

# ─── Step 3: Link AO skills to user .claude ──────────────────────────────────
echo "[3/7] Linking AO skills..."
if [ -f "$SCRIPT_DIR/install-repo-skills.sh" ]; then
  bash "$SCRIPT_DIR/install-repo-skills.sh" --global 2>/dev/null || echo "  (skills install skipped)"
fi

# ─── Step 4: Verify hermes gateway health ───────────────────────────────────
echo "[4/7] Checking Hermes gateway..."
if command -v hermes &>/dev/null; then
  if HERMES_HOME="$HERMES_HOME" hermes gateway status 2>&1 | grep -q "Gateway is running"; then
    echo "  Hermes gateway: running"
  else
    echo "  Hermes gateway: not running (start with: hermes gateway start)"
  fi
else
  echo "  Hermes CLI not found — skipping"
fi

# ─── Step 5: Run setup-extended.sh (rebuild CLI + launchd + webhook) ─────────
echo "[5/7] Running setup-extended.sh..."
if [ -f "$SCRIPT_DIR/setup-extended.sh" ]; then
  run_filter 30 '^\[|^ok|^WARNING|═══|complete|Installing' \
    env AO_CONFIG_PATH="$CONFIG_FILE" bash "$SCRIPT_DIR/setup-extended.sh"
else
  echo "  setup-extended.sh not found — skipping"
fi

# ─── Step 6: Verify lifecycle workers ────────────────────────────────────────
echo "[6/7] Verifying lifecycle workers..."
WORKER_COUNT=0

if ! launchctl print "gui/$(id -u)/ai.agento.lifecycle-all" >/dev/null 2>&1; then
  echo "  - lifecycle-all service not loaded"
else
  for pid in $PROJECTS; do
    # The lifecycle-all plist manages all workers; check via pgrep for per-project liveness
    escaped_pid=$(printf '%s' "$pid" | sed -e 's/[][().*^$+?{}|\\]/\\&/g')
    if pgrep -f "lifecycle-worker[[:space:]].*${escaped_pid}([[:space:]]|$)" >/dev/null 2>&1; then
      WORKER_COUNT=$((WORKER_COUNT + 1))
      echo "  + $pid: running"
    else
      echo "  - $pid: not running"
    fi
  done
fi

# ─── Step 7: Final verification via ao doctor ────────────────────────────────
echo "[7/7] Running ao doctor..."
if command -v ao &>/dev/null; then
  AO_CONFIG_PATH="$CONFIG_FILE" ao doctor 2>&1 | grep -E '(PASS|WARN|FAIL|Results:)' | tail -5
  DOCTOR_RESULT=${PIPESTATUS[0]}
else
  echo "  ao CLI not in PATH — run: export PATH=\"$(npm config get prefix)/bin:$PATH\""
  DOCTOR_RESULT=1
fi

# ─── Keep repo for curl mode ─────────────────────────────────────────────────
# In curl mode the clone is stored at a stable path (not a temp dir),
# so we keep it — install-repo-skills.sh creates symlinks into the repo
# and setup-extended.sh may install launchd jobs pointing to its scripts.

echo ""
if [ "${DOCTOR_RESULT:-0}" -eq 0 ]; then
  echo "=== Install Complete ==="
  echo "Mode: $MODE"
  echo "Config: $CONFIG_FILE"
  echo "Workers running: $WORKER_COUNT/$(echo "$PROJECTS" | wc -w)"
else
  echo "=== Install Failed — ao doctor reported issues ==="
  echo "Mode: $MODE"
  echo "Config: $CONFIG_FILE"
  echo "Workers running: $WORKER_COUNT/$(echo "$PROJECTS" | wc -w)"
  exit 1
fi
echo ""
echo "Next steps:"
echo "  ao spawn --project agent-orchestrator 'echo hello'"
echo "  ao status"
echo "  cat $CONFIG_FILE"