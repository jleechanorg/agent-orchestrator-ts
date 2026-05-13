#!/bin/bash
# Agent Orchestrator setup script
# Validates prerequisites, installs dependencies, builds packages, and installs the CLI globally (pnpm install -g).

set -e  # Exit on error

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/ao-config-topology.sh
source "$SCRIPT_DIR/lib/ao-config-topology.sh"
# shellcheck source=./lib/pnpm-global-path.sh
source "$SCRIPT_DIR/lib/pnpm-global-path.sh"

echo "Agent Orchestrator Setup"
echo ""

# ─── Hard requirements (exit 1 if missing) ────────────────────────────────────

# Node.js >= 20
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "  Install Node.js 20+: https://nodejs.org/en/download"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js $NODE_MAJOR.x detected, but 20+ is required."
  echo "  Install Node.js 20+: https://nodejs.org/en/download"
  exit 1
fi
echo "[ok] Node.js $(node --version)"

# git >= 2.25 (required for worktree support)
if ! command -v git &> /dev/null; then
  echo "ERROR: git is not installed."
  echo "  Install git 2.25+: https://git-scm.com/downloads"
  exit 1
fi

GIT_VERSION=$(git --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
GIT_MAJOR=$(echo "$GIT_VERSION" | cut -d. -f1)
GIT_MINOR=$(echo "$GIT_VERSION" | cut -d. -f2)
if [ "$GIT_MAJOR" -lt 2 ] || { [ "$GIT_MAJOR" -eq 2 ] && [ "$GIT_MINOR" -lt 25 ]; }; then
  echo "ERROR: git $GIT_VERSION detected, but 2.25+ is required (worktree support)."
  echo "  Upgrade git: https://git-scm.com/downloads"
  exit 1
fi
echo "[ok] git $GIT_VERSION"

# ─── Soft requirements (warn + offer interactive fix) ─────────────────────────

# Detect interactive terminal for optional prompts (skip in CI/Docker)
INTERACTIVE=false
if [ -t 0 ]; then
  INTERACTIVE=true
fi

# tmux
if ! command -v tmux &> /dev/null; then
  echo ""
  echo "WARNING: tmux is not installed (default runtime requires it)."
  if [ "$INTERACTIVE" = true ] && command -v brew &> /dev/null; then
    read -r -p "  Install tmux via Homebrew? [Y/n] " response
    response=${response:-Y}
    if [[ "$response" =~ ^[Yy]$ ]]; then
      brew install tmux
      echo "[ok] tmux installed"
    else
      echo "  Skipping. Install later: brew install tmux"
    fi
  else
    echo "  Install tmux: https://github.com/tmux/tmux/wiki/Installing"
  fi
else
  echo "[ok] tmux $(tmux -V | grep -oE '[0-9]+\.[0-9a-z]+')"
fi

# gh CLI authentication
if ! command -v gh &> /dev/null; then
  echo ""
  echo "WARNING: GitHub CLI (gh) is not installed."
  echo "  Install: https://cli.github.com/"
else
  if ! gh auth status &> /dev/null; then
    echo ""
    echo "WARNING: GitHub CLI is not authenticated."
    if [ "$INTERACTIVE" = true ]; then
      read -r -p "  Run 'gh auth login' now? [Y/n] " response
      response=${response:-Y}
      if [[ "$response" =~ ^[Yy]$ ]]; then
        gh auth login
      else
        echo "  Skipping. Authenticate later: gh auth login"
      fi
    else
      echo "  Authenticate later: gh auth login"
    fi
  else
    echo "[ok] gh authenticated"
  fi
fi

# claude CLI
if ! command -v claude &> /dev/null; then
  echo ""
  echo "WARNING: Claude CLI is not installed (required for claude-code agent)."
  echo "  Install: npm install -g @anthropic-ai/claude-code"
fi

echo ""

# ─── Install pnpm ────────────────────────────────────────────────────────────

if command -v pnpm &> /dev/null; then
  echo "[ok] pnpm $(pnpm --version) (already installed)"
else
  echo "Installing pnpm via corepack..."
  if corepack enable && corepack prepare --activate 2>/dev/null; then
    echo "[ok] pnpm $(pnpm --version)"
  else
    echo "  corepack failed (likely permissions), falling back to npm install..."
    npm install -g pnpm
    echo "[ok] pnpm $(pnpm --version)"
  fi
fi

# Pin pnpm via Corepack/packageManager — npm-global pnpm (often v10) mismatches workspace (pnpm@9 in package.json)
if command -v corepack &> /dev/null; then
  ( cd "$REPO_ROOT" && corepack enable >/dev/null 2>&1 && corepack install >/dev/null 2>&1 ) || true
  hash -r 2>/dev/null || true
fi

# ─── Install, build, global CLI (pnpm install -g — not npm link; workspace deps
# cannot be installed via npm install -g from this tree) ─────────────────────

echo ""
echo "Installing dependencies..."
pnpm install

echo ""
echo "Cleaning stale build artifacts..."
rm -rf packages/web/.next

echo ""
echo "Building all packages..."
pnpm build

echo ""
echo "Refreshing workspace bin links after build..."
pnpm install --prefer-offline

echo ""
echo "Installing CLI globally (pnpm install -g ${REPO_ROOT}/packages/cli)..."
# Install from REPO_ROOT so pnpm resolves workspace:* deps. Put workspace toolchain first —
# global npm-installed pnpm (e.g. in Docker tests) may be a different major than the repo pin.
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="${REPO_ROOT}/node_modules/.bin:${PNPM_HOME}:${PATH}"
hash -r 2>/dev/null || true
PNPM_BIN="$(command -v pnpm || true)"
if [ -z "$PNPM_BIN" ]; then
  echo "ERROR: pnpm not found. Enable corepack (corepack prepare pnpm --activate) or install pnpm."
  exit 1
fi
if ! mkdir -p "$PNPM_HOME" 2>/dev/null; then
  echo "ERROR: cannot create PNPM_HOME: $PNPM_HOME"
  exit 1
fi

CLI_DIST="${REPO_ROOT}/packages/cli/dist/index.js"
if [ -f "$CLI_DIST" ]; then
  chmod +x "$CLI_DIST" || true
fi

"$PNPM_BIN" remove -g @jleechanorg/ao-cli 2>/dev/null || true

if (cd "$REPO_ROOT" && "$PNPM_BIN" install -g "$REPO_ROOT/packages/cli"); then
  :
elif [ "$INTERACTIVE" = true ]; then
  echo "  Permission denied. Retrying with sudo..."
  if sudo -H env PNPM_HOME="$PNPM_HOME" PATH="${REPO_ROOT}/node_modules/.bin:${PNPM_HOME}:$(dirname "$PNPM_BIN"):$PATH" "$PNPM_BIN" install -g "$REPO_ROOT/packages/cli"; then
    :
  else
    echo "ERROR: pnpm install -g failed. Run: sudo pnpm install -g \"${REPO_ROOT}/packages/cli\""
    exit 1
  fi
else
  echo "ERROR: Permission denied. Run manually: pnpm install -g \"${REPO_ROOT}/packages/cli\""
  exit 1
fi

export AO_PNPM_FOR_GLOBAL="$PNPM_BIN"
append_pnpm_global_paths
unset AO_PNPM_FOR_GLOBAL

# Rehash PATH lookups after append_pnpm_global_paths may have added directories.
hash -r 2>/dev/null || true

if ! command -v ao >/dev/null 2>&1; then
  # Diagnostic: where did pnpm install -g put the shim?
  echo "WARNING: 'ao' not on PATH after pnpm install -g. Diagnosing..."
  echo "  PNPM_HOME=$PNPM_HOME"
  _pgbin="$("$PNPM_BIN" bin -g 2>/dev/null)" || _pgbin="(failed)"
  _pgroot="$("$PNPM_BIN" root -g 2>/dev/null)" || _pgroot="(failed)"
  echo "  pnpm bin -g: $_pgbin"
  echo "  pnpm root -g: $_pgroot"
  # List ao shim locations
  for candidate in "$PNPM_HOME/ao" "$HOME/.local/share/pnpm/ao" "/usr/local/bin/ao"; do
    if [ -f "$candidate" ]; then
      echo "  Found ao shim at: $candidate"
      candidate_dir="$(dirname "$candidate")"
      export PATH="$candidate_dir:$PATH"
      hash -r 2>/dev/null || true
    fi
  done
fi

if ! command -v ao >/dev/null 2>&1; then
  echo "ERROR: pnpm install -g succeeded but 'ao' is not on PATH (PNPM_HOME=${PNPM_HOME:-})."
  exit 1
fi

echo ""
echo "Installing repo AO skill into user skill directories..."
bash "$REPO_ROOT/scripts/install-repo-skills.sh"

# ─── Verify ao is in PATH ────────────────────────────────────────────────────
# (Already verified above — the early exit on line 179-182 guarantees ao is available here.)
echo ""
if command -v ao &> /dev/null; then
  echo "[ok] 'ao' command is available in PATH"
else
  # npm 10+ removed `npm bin -g`; `npm prefix -g` is the supported global root.
  _npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$_npm_global_prefix" ]; then
    NPM_BIN="$_npm_global_prefix/bin"
  else
    NPM_BIN=""
  fi
  echo "WARNING: 'ao' is not in your PATH."
  echo "  pnpm global bin dir: ${PNPM_HOME:-$HOME/.local/share/pnpm}"
  echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo ""
  echo "    export PNPM_HOME=\"\${PNPM_HOME:-\$HOME/.local/share/pnpm}\""
  if [ -n "$NPM_BIN" ]; then
    echo "    export PATH=\"\$PNPM_HOME:$NPM_BIN:\$PATH\""
  else
    echo "    export PATH=\"\$PNPM_HOME:\$PATH\""
  fi
  echo ""
  echo "  Then restart your terminal or run: source ~/.zshrc"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "Base setup complete!"

BOOTSTRAP_SCRIPT="$REPO_ROOT/scripts/bootstrap-openclaw-config.sh"
if [ -f "$BOOTSTRAP_SCRIPT" ]; then
  bash "$BOOTSTRAP_SCRIPT"
fi

# ─── Fork-specific extended setup ───────────────────────────────────────────

EXTENDED_SCRIPT="$REPO_ROOT/scripts/setup-extended.sh"
CONFIG_FILE="${AO_CONFIG_PATH:-$(ao_staging_config_path)}"
if [ -f "$EXTENDED_SCRIPT" ] && [ -f "$CONFIG_FILE" ]; then
  AO_CONFIG_PATH="$CONFIG_FILE" bash "$EXTENDED_SCRIPT"
elif [ -f "$EXTENDED_SCRIPT" ]; then
  echo "  Skipping extended setup (no config at $CONFIG_FILE — run 'ao start' to create one)"
fi

echo ""
echo "What's next:"
echo ""
echo "  Navigate to your project directory and start:"
echo ""
echo "    cd ~/your-project"
echo "    ao start            # auto-detects, creates config, launches dashboard"
echo "    ao --help           # detailed CLI examples"
echo ""
echo "  Want to add more projects later?"
echo ""
echo "    ao start ~/path/to/another-repo"
echo ""
