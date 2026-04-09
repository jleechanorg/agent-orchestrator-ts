#!/bin/bash
# Validate agent-orchestrator.yaml parses as valid YAML with no duplicate keys.
# Usage: ./scripts/validate-config.sh [config-path]
# Exit 0 = valid, exit 1 = parse error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/ao-config-topology.sh
source "$SCRIPT_DIR/lib/ao-config-topology.sh"

CONFIG_FILE="${1:-}"
if [ -z "$CONFIG_FILE" ]; then
  if [ -n "${AO_CONFIG_PATH:-}" ]; then
    CONFIG_FILE="$AO_CONFIG_PATH"
  elif CONFIG_FILE="$(ao_find_config_path 2>/dev/null)"; then
    :
  else
    CONFIG_FILE="$(ao_staging_config_path)"
  fi
fi

ao_validate_topology

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config not found at $CONFIG_FILE"
  exit 1
fi

node - "$CONFIG_FILE" <<'NODEEOF'
const fs = require("node:fs");
const YAML = require("yaml");

const path = process.argv[2];

try {
  const doc = YAML.parseDocument(fs.readFileSync(path, "utf8"), {
    uniqueKeys: true,
  });
  if (doc.errors.length > 0) {
    const message = doc.errors.map((error) => error.message).join("\n");
    console.error(`ERROR: ${path}\n${message}`);
    process.exit(1);
  }
  console.log(`OK: ${path} is valid YAML`);
} catch (error) {
  console.error(`ERROR: ${path}\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
NODEEOF
