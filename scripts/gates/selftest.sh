#!/usr/bin/env bash
# Smoke test: install templates into a temp dir and verify files exist.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"$ROOT/install-gates.sh" "$TMP"
test -f "$TMP/.github/workflows/skeptic-gate.yml"
test -f "$TMP/.github/workflows/evidence-gate.yml"
"$ROOT/install-gates.sh" --dry-run "$TMP" | grep -q dry-run
echo "scripts/gates selftest: OK"
