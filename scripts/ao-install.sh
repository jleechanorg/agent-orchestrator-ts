#!/bin/bash
# ao-install.sh — Consolidated AO worker-node install
# Replaces: setup.sh + bootstrap-openclaw-config.sh + setup-extended.sh
# Usage: curl -fsSL https://raw.githubusercontent.com/jleechanorg/agent-orchestrator/main/scripts/ao-install.sh | bash
# Or:     bash /tmp/ao-install.sh  (run from a clone of agent-orchestrator)
# Requirements: git, curl, bash 4+, npm (for ao CLI build)

set -euo pipefail

# Run a command, filter its output through grep/head, exit non-zero on command failure.
# stdin is connected to /dev/null to prevent interactive prompts from causing silent hangs
# (setup.sh enables interactive mode when stdin is a tty, issuing read prompts that write to
# stderr which gets redirected to the log — leaving the terminal invisible and read waiting).
run_filtered() {
  local filter="$1"; local limit="$2"; shift 2
  local log
  log="$(mktemp)"
  if ! "$@" >"$log" 2>&1 </dev/null; then
    grep -E "$filter" "$log" | head -n "$limit" || true
    rm -f "$log"
    return 1
  fi
  grep -E "$filter" "$log" | head -n "$limit" || true
  rm -f "$log"
}

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
#   repo  — running from an existing ~/project_agento/agent-orchestrator clone
#   curl  — piped from curl, need to clone first

# Track whether we created a temp clone (in curl mode) so we can clean up on error.
_CURL_MODE_CLONE=false

if [ -d "$AO_REPO_ROOT/.git" ]; then
  REPO_ROOT="$AO_REPO_ROOT"
  echo "  Repo detected: $REPO_ROOT"
else
  MODE="curl"
  REPO_ROOT="$AO_REPO_ROOT"
  mkdir -p "$(dirname "$REPO_ROOT")"
  if [ -e "$REPO_ROOT" ] && [ ! -d "$REPO_ROOT/.git" ]; then
    echo "ERROR: $REPO_ROOT exists but is not an agent-orchestrator clone"
    exit 1
  fi
  if [ ! -d "$REPO_ROOT/.git" ]; then
    echo "  Cloning agent-orchestrator to $REPO_ROOT..."
    git clone --branch "$AGENT_ORCHESTRATOR_BRANCH" \
      "$AGENT_ORCHESTRATOR_REPO" "$REPO_ROOT" >/dev/null 2>&1
  fi
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
echo "  Projects: $(echo "$PROJECTS" | tr ' ' ', ')"

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
    escaped_pid=$(printf '%s' "$pid" | sed -e 's/[][^$.*/\\]/\\&/g')
    if pgrep -f "lifecycle-worker[[:space:]].*${escaped_pid}([[:space:]]|$)" >/dev/null 2>&1; then
      WORKER_COUNT=$((WORKER_COUNT + 1))
      echo "  + $pid: running"
    else
      echo "  - $pid: not running"
    fi
  done
fi

# ─── Step 7: Final verification via ao doctor ──────────────────────────────────
echo "[7/7] Running ao doctor..."
if command -v ao &>/dev/null; then
  # ao doctor exits non-zero when any health check fails — suppress that to avoid
  # masking the actual install work; still surface its filtered output for visibility
  run_filtered '(PASS|WARN|FAIL|Results:)' 5 env AO_CONFIG_PATH="$CONFIG_FILE" ao doctor
else
  echo "  ao CLI not in PATH — run: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
fi

# ─── Keep repo for curl mode ─────────────────────────────────────────────────
# In curl mode the clone is stored at a stable path (not a temp dir),
# so we keep it — install-repo-skills.sh creates symlinks into the repo
# and setup-extended.sh may install launchd jobs pointing to its scripts.

echo ""
echo "=== Install Complete ==="
echo "Config: $CONFIG_FILE"
echo "Workers running: $WORKER_COUNT/$(echo "$PROJECTS" | wc -w)"
echo ""
echo "Next steps:"
echo "  AO_CONFIG_PATH=\"$CONFIG_FILE\" ao spawn --project agent-orchestrator 'echo hello'"
echo "  AO_CONFIG_PATH=\"$CONFIG_FILE\" ao status"
echo "  cat $CONFIG_FILE"
