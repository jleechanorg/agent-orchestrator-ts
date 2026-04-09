#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/ao-config-topology.sh
source "$SCRIPT_DIR/lib/ao-config-topology.sh"

SOURCE_CONFIG="${1:-$(ao_staging_config_path)}"
TARGET_CONFIG="$(ao_production_config_path)"

if [ ! -f "$SOURCE_CONFIG" ]; then
  printf 'Source config not found: %s\n' "$SOURCE_CONFIG" >&2
  exit 1
fi

ao_validate_topology
"$REPO_ROOT/scripts/validate-config.sh" "$SOURCE_CONFIG"

SOURCE_REAL="$(ao_realpath "$SOURCE_CONFIG")"
TARGET_REAL="$(ao_realpath "$TARGET_CONFIG")"
if [ "$SOURCE_REAL" = "$TARGET_REAL" ]; then
  printf 'Refusing to promote because source and target resolve to the same file: %s\n' "$SOURCE_REAL" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_CONFIG")"
TMP_TARGET="${TARGET_CONFIG}.tmp.$$"
cp "$SOURCE_CONFIG" "$TMP_TARGET"
"$REPO_ROOT/scripts/validate-config.sh" "$TMP_TARGET"
chmod 600 "$TMP_TARGET"
mv "$TMP_TARGET" "$TARGET_CONFIG"

echo "Promoted validated config into production: $TARGET_CONFIG"
