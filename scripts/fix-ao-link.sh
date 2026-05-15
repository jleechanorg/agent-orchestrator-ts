#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/pnpm-global-path.sh
source "$SCRIPT_DIR/lib/pnpm-global-path.sh"

if [[ "$REPO_ROOT" == "$HOME/.worktrees/"* || "$REPO_ROOT" == */.worktrees/* ]] && [ "${AO_ALLOW_WORKTREE_LINK:-}" != "1" ]; then
  echo "ERROR: Refusing to globally relink ao from an AO worktree: $REPO_ROOT" >&2
  echo "  Install the tool with: npm install -g @jleechanorg/ao-cli" >&2
  echo "  Maintainers who intentionally want this worktree on PATH can rerun with AO_ALLOW_WORKTREE_LINK=1." >&2
  exit 1
fi

echo "==> Fixing ao link..."

export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="${REPO_ROOT}/node_modules/.bin:${PNPM_HOME}:${PATH}"
hash -r 2>/dev/null || true
PNPM_BIN="$(command -v pnpm || true)"
if [ -z "$PNPM_BIN" ]; then
  echo "ERROR: pnpm not found." >&2
  exit 1
fi

GLOBAL_MODULES="$("$PNPM_BIN" root -g 2>/dev/null || true)"
if [ -e "$GLOBAL_MODULES/@jleechanorg/ao-cli" ]; then
  echo "  Removing stale global @jleechanorg/ao-cli link..."
  rm -rf "$GLOBAL_MODULES/@jleechanorg/ao-cli"
fi
mkdir -p "$PNPM_HOME" 2>/dev/null || true

"$PNPM_BIN" remove -g @jleechanorg/ao-cli 2>/dev/null || true

DIST="$CLI_DIR/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "  dist/index.js missing — building..."
  (cd "$REPO_ROOT" && pnpm --filter @jleechanorg/ao-cli build)
fi
chmod +x "$DIST"
echo "  chmod +x $DIST"

echo "  Running pnpm install -g ${REPO_ROOT}/packages/cli ..."
if (cd "$REPO_ROOT" && "$PNPM_BIN" install -g "$REPO_ROOT/packages/cli"); then
  :
else
  echo "  Retrying with sudo from repo root..."
  (cd "$REPO_ROOT" && sudo -H env PNPM_HOME="$PNPM_HOME" PATH="${REPO_ROOT}/node_modules/.bin:${PNPM_HOME}:$(dirname "$PNPM_BIN"):$PATH" "$PNPM_BIN" install -g "$REPO_ROOT/packages/cli")
fi

AO_PATH="$(command -v ao 2>/dev/null || true)"
if [ -n "$AO_PATH" ]; then
  AO_REAL="$(realpath "$AO_PATH" 2>/dev/null || printf '%s' "$AO_PATH")"
  if [[ "$AO_REAL" == "$HOME/.worktrees/"* || "$AO_REAL" == */.worktrees/* ]]; then
    echo "ERROR: Post-install verification failed — ao still resolves to a worktree: $AO_PATH -> $AO_REAL" >&2
    echo "  Fix: npm install -g @jleechanorg/ao-cli, or run fix-ao-link.sh from the main clone" >&2
    exit 1
  fi
fi

if ao --version &>/dev/null; then
  echo "==> ao $(ao --version) installed successfully"
else
  echo "ERROR: ao still not working after pnpm global install (${REPO_ROOT}/packages/cli)" >&2
  exit 1
fi
