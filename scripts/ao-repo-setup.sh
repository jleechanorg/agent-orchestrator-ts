#!/bin/bash
# ao-repo-setup.sh — Bootstrap a fresh AO worker node
# Replaces multiple legacy config directories with ~/.openclaw_prod/ as canonical location.
# Usage: curl -fsSL https://raw.githubusercontent.com/jleechanorg/agent-orchestrator/main/scripts/ao-repo-setup.sh | bash
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes_prod}"
OPENCLAW_PROD="${OPENCLAW_PROD:-$HOME/.openclaw_prod}"
AGENT_ORCHESTRATOR_REPO="${AGENT_ORCHESTRATOR_REPO:-https://github.com/jleechanorg/agent-orchestrator}"
AGENT_ORCHESTRATOR_BRANCH="${AGENT_ORCHESTRATOR_BRANCH:-main}"

echo "=== AO Repo Setup ==="
echo "Hermes home: $HERMES_HOME"
echo "OpenClaw prod: $OPENCLAW_PROD"
echo "Repo: $AGENT_ORCHESTRATOR_REPO ($AGENT_ORCHESTRATOR_BRANCH)"
echo

# Step 1: Verify AO config exists (canonical location is ~/.openclaw_prod/)
AO_CONFIG="$OPENCLAW_PROD/agent-orchestrator.yaml"
if [ ! -f "$AO_CONFIG" ]; then
    echo "ERROR: $AO_CONFIG not found."
    echo "Run 'ao-install.sh' first to bootstrap the AO config."
    exit 1
fi
echo "[1/6] AO config verified: $AO_CONFIG"

# Step 2: Verify ao CLI is installed
if ! command -v ao &>/dev/null; then
    echo "ERROR: 'ao' CLI not found. Install: npm install -g @jleechanorg/ao-cli"
    exit 1
fi
AO_VERSION=$(ao --version 2>/dev/null || echo "unknown")
echo "[2/6] AO CLI: $AO_VERSION"

# Step 3: Verify hermes gateway is running
if ! command -v hermes &>/dev/null; then
    echo "[3/6] WARNING: Hermes CLI not installed (skipping gateway check)"
elif HERMES_STATUS=$(hermes gateway status 2>&1) && echo "$HERMES_STATUS" | grep -q "Gateway is running"; then
    echo "[3/6] Hermes gateway: running"
else
    echo "[3/6] WARNING: Hermes gateway not running."
    echo "Start with: hermes gateway start"
    echo "Or: ./bin/hermes gateway start"
fi

# Step 4: Check workspace directory
WORKTREE_DIR=$(python3 -c "
import yaml, os
c = yaml.safe_load(open('$AO_CONFIG'))
wt = c.get('worktreeDir', os.path.join(os.environ.get('HOME', ''), '.worktrees'))
print(os.path.expanduser(wt))
" 2>/dev/null || echo "$HOME/.worktrees")
mkdir -p "$WORKTREE_DIR"
echo "[4/6] Worktree dir: $WORKTREE_DIR"

# Step 5: Check launchd for lifecycle worker
# The canonical service is ai.agento.lifecycle-all (uses start-all.sh),
# NOT the old per-project com.agentorchestrator.lifecycle-* plists.
if launchctl print "gui/$(id -u)/ai.agento.lifecycle-all" >/dev/null 2>&1; then
  echo "[5/6] Lifecycle worker: installed via ai.agento.lifecycle-all (launchd)"
else
  echo "[5/6] Lifecycle worker: NOT installed via launchd (run 'ao setup-launchd' or setup-extended.sh)"
fi

# Step 6: Verify agent-orchestrator repo is accessible
AO_CLONE_DIR="$HOME/project_agento/agent-orchestrator"
if [ -d "$AO_CLONE_DIR/.git" ]; then
    echo "[6/6] Agent-orchestrator repo: $AO_CLONE_DIR (already cloned)"
else
    echo "[6/6] Agent-orchestrator repo: will be cloned on first ao spawn"
fi

echo
echo "=== Setup Complete ==="
echo "AO config: $AO_CONFIG"
echo "Worktrees: $WORKTREE_DIR"
echo "AO CLI: $(which ao)"
echo
echo "Next steps:"
echo "  ao spawn --project agent-orchestrator 'echo hello'"
echo "  ao lifecycle-status"
