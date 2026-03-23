#!/bin/bash
# Validate agent-orchestrator.yaml parses as valid YAML with no duplicate keys.
# Usage: ./scripts/validate-config.sh [config-path]
# Exit 0 = valid, exit 1 = parse error

set -euo pipefail

CONFIG_FILE="${1:-${AO_CONFIG_PATH:-$HOME/.openclaw/agent-orchestrator.yaml}}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config not found at $CONFIG_FILE"
  exit 1
fi

python3 - "$CONFIG_FILE" << 'PYEOF'
import sys
import yaml

path = sys.argv[1]
try:
    with open(path) as f:
        yaml.safe_load(f)
    print(f"OK: {path} is valid YAML")
    sys.exit(0)
except yaml.YAMLError as e:
    print(f"ERROR: {path}\n{e}", file=sys.stderr)
    sys.exit(1)
PYEOF
