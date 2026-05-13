#!/usr/bin/env bash
# Fix ao CLI global install after ao-update/setup fails (permissions or stale global package).
# Install with absolute workspace path so pnpm does not resolve relative to the global prefix.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"

echo "==> Refreshing global ao (pnpm install -g ${REPO_ROOT}/packages/cli)..."
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="${REPO_ROOT}/node_modules/.bin:${PNPM_HOME}:${PATH}"
hash -r 2>/dev/null || true
PNPM_BIN="$(command -v pnpm || true)"
if [ -z "$PNPM_BIN" ]; then
  echo "ERROR: pnpm not found." >&2
  exit 1
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

if ao --version &>/dev/null; then
  echo "==> ao $(ao --version) installed successfully"
else
  echo "ERROR: ao still not working after pnpm global install (${REPO_ROOT}/packages/cli)" >&2
  exit 1
fi
