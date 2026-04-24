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
  echo "[0/7] Repo detected: $REPO_ROOT"
else
  MODE="curl"
  REPO_ROOT="$(mktemp -d)"
  echo "[0/7] Cloning agent-orchestrator to $REPO_ROOT..."
  git clone --branch "$AGENT_ORCHESTRATOR_BRANCH" \
    "$AGENT_ORCHESTRATOR_REPO" "$REPO_ROOT" >/dev/null 2>&1
fi

SCRIPT_DIR="$REPO_ROOT/scripts"

# ─── Step 1: Install dependencies + build CLI ────────────────────────────────
echo "[1/7] Running setup.sh (install + build)..."
SETUP_LOG="$(mktemp)"
if ! bash "$SCRIPT_DIR/setup.sh" >"$SETUP_LOG" 2>&1; then
  grep -E '^\[ok\]|\[ERROR\]|ERROR|complete' "$SETUP_LOG" | head -20 || true
  echo "ERROR: setup.sh failed. See full log at $SETUP_LOG"
  exit 1
fi
grep -E '^\[ok\]|\[ERROR\]|ERROR|complete' "$SETUP_LOG" | head -20 || true
rm -f "$SETUP_LOG"

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
  echo "    repo: jleechanorg/$pid" >> "$CONFIG_FILE"
  echo "    path: ~/project_agento/$pid" >> "$CONFIG_FILE"
  echo "    scm:" >> "$CONFIG_FILE"
  echo "      plugin: github" >> "$CONFIG_FILE"
done

chmod 600 "$CONFIG_FILE"
echo "  Config written: $CONFIG_FILE"
echo "  Projects: $(echo "$PROJECTS" | tr ' ' ', ')"

# ─── Step 3: Link AO skills to user .claude ──────────────────────────────────
echo "[3/7] Linking AO skills..."
if [ -f "$SCRIPT_DIR/install-repo-skills.sh" ]; then
  SKILLS_LOG="$(mktemp)"
  if bash "$SCRIPT_DIR/install-repo-skills.sh" --global >"$SKILLS_LOG" 2>&1; then
    grep -v "^$" "$SKILLS_LOG" || true
  else
    grep -v "^$" "$SKILLS_LOG" || true
    echo "  WARNING: skills install had errors (continuing anyway)"
  fi
  rm -f "$SKILLS_LOG"
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
  EXTENDED_LOG="$(mktemp)"
  if ! AO_CONFIG_PATH="$CONFIG_FILE" bash "$SCRIPT_DIR/setup-extended.sh" >"$EXTENDED_LOG" 2>&1; then
    grep -E '^\[|^ok|^WARNING|═══|complete|Installing' "$EXTENDED_LOG" | head -30 || true
    echo "  WARNING: setup-extended.sh had errors (see above)"
  else
    grep -E '^\[|^ok|^WARNING|═══|complete|Installing' "$EXTENDED_LOG" | head -30 || true
  fi
  rm -f "$EXTENDED_LOG"
else
  echo "  setup-extended.sh not found — skipping"
fi

# ─── Step 6: Verify lifecycle workers ────────────────────────────────────────
echo "[6/7] Verifying lifecycle workers..."
WORKER_COUNT=0
if [ "$(uname)" != "Darwin" ]; then
  echo "  - launchd not available (non-macOS)"
elif launchctl print "gui/$(id -u)/ai.agento.lifecycle-all" >/dev/null 2>&1; then
  for pid in $PROJECTS; do
    if pgrep -f "lifecycle-worker[[:space:]].*${pid}([[:space:]]|\$)" >/dev/null 2>&1; then
      WORKER_COUNT=$((WORKER_COUNT + 1))
      echo "  + $pid: running"
    else
      echo "  - $pid: not running"
    fi
  done
else
  echo "  - lifecycle-all service not loaded"
fi

# ─── Step 7: Final verification via ao doctor ────────────────────────────────
echo "[7/7] Running ao doctor..."
if command -v ao &>/dev/null; then
  AO_CONFIG_PATH="$CONFIG_FILE" ao doctor 2>&1 | grep -E '(PASS|WARN|FAIL|Results:)' | tail -5 || true
else
  echo "  ao CLI not in PATH — run: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
fi

# ─── Cleanup on curl mode ────────────────────────────────────────────────────
if [ "$MODE" = "curl" ]; then
  echo ""
  echo "Cleaning up temp clone..."
  rm -rf "$REPO_ROOT"
fi

echo ""
echo "=== Install Complete ==="
echo "Config: $CONFIG_FILE"
echo "Workers running: $WORKER_COUNT/$(echo "$PROJECTS" | wc -w)"
echo ""
echo "Next steps:"
echo "  ao spawn --project agent-orchestrator 'echo hello'"
echo "  ao status"
echo "  cat $CONFIG_FILE"