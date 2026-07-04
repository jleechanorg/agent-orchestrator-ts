#!/usr/bin/env bash
# Install the bead-JSONL sort pre-commit hook for the current clone.
# Idempotent: re-running overwrites the hook with the latest version.
# Per-clone: hooks don't transfer across clones (git by design).
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_FILE="$REPO_ROOT/.git/hooks/pre-commit"
mkdir -p "$(dirname "$HOOK_FILE")"
cat > "$HOOK_FILE" << 'INNER'
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
SORTER="$REPO_ROOT/scripts/sort_beads_jsonl.py"
if [ ! -x "$SORTER" ]; then exit 0; fi
if git diff --cached --name-only | grep -q "^\.beads/issues\.jsonl$"; then
  "$SORTER"; git add .beads/issues.jsonl
fi
INNER
chmod +x "$HOOK_FILE"
echo "Installed pre-commit hook at $HOOK_FILE"
