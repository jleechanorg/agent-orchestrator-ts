#!/usr/bin/env bash
# Delegate to the canonical repo-root script (single source of truth).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec "$ROOT/scripts/ao-update.sh" "$@"
