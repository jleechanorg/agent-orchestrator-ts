#!/usr/bin/env bash
# Fix ao CLI global install after ao-update/setup fails (permissions or stale global package).
# Uses pnpm install -g . (npm link / npm install -g from tarball do not work for this monorepo).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
PNPM_BIN="$(command -v pnpm || true)"

echo "==> Refreshing global ao (pnpm install -g)..."
if [ -z "$PNPM_BIN" ]; then
  echo "ERROR: pnpm not found." >&2
  exit 1
fi

export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"
mkdir -p "$PNPM_HOME" 2>/dev/null || true

# Drop stale global install if present (ignore if absent)
pnpm remove -g @jleechanorg/ao-cli 2>/dev/null || true

DIST="$CLI_DIR/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "  dist/index.js missing — building..."
  (cd "$REPO_ROOT" && pnpm --filter @jleechanorg/ao-cli build)
fi
chmod +x "$DIST"
echo "  chmod +x $DIST"

echo "  Running pnpm install -g . from $CLI_DIR..."
if (cd "$CLI_DIR" && "$PNPM_BIN" install -g .); then
  :
else
  echo "  Retrying with sudo..."
  sudo -H env PNPM_HOME="$PNPM_HOME" PATH="$PNPM_HOME:$(dirname "$PNPM_BIN"):$PATH" "$PNPM_BIN" install -g "$CLI_DIR"
fi

if ao --version &>/dev/null; then
  echo "==> ao $(ao --version) installed successfully"
else
  echo "ERROR: ao still not working after pnpm install -g" >&2
  exit 1
fi
