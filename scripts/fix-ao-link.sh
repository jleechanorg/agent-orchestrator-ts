#!/usr/bin/env bash
# Fix ao binary permissions and npm link after ao-update fails with "Permission denied"
# Root cause: dist/index.js lacks execute bit; npm arborist state is stale
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
NODE_BIN="$(dirname "$(command -v node)")"
GLOBAL_MODULES="$(npm root -g)"

echo "==> Fixing ao link..."

# 1. Remove stale global link (arborist gets confused when it already exists)
if [ -e "$GLOBAL_MODULES/@jleechanorg/ao-cli" ]; then
  echo "  Removing stale global @jleechanorg/ao-cli link..."
  rm -rf "$GLOBAL_MODULES/@jleechanorg/ao-cli"
fi

# 2. Remove stale ao bin symlink
if [ -e "$NODE_BIN/ao" ]; then
  echo "  Removing stale ao bin symlink..."
  rm -f "$NODE_BIN/ao"
fi

# 3. Ensure dist/index.js exists and has execute bit
DIST="$CLI_DIR/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "  dist/index.js missing — building..."
  (cd "$REPO_ROOT" && pnpm --filter @jleechanorg/ao-cli build)
fi
chmod +x "$DIST"
echo "  chmod +x $DIST"

# 4. Re-link
echo "  Running npm link from $CLI_DIR..."
(cd "$CLI_DIR" && npm link)

# 5. Verify
if ao --version &>/dev/null; then
  echo "==> ao $(ao --version) linked successfully"
else
  echo "ERROR: ao still not working after relink" >&2
  exit 1
fi
