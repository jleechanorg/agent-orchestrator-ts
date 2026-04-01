#!/usr/bin/env bash
# Install Skeptic Gate + Evidence Gate workflows into another Git repository.
# Source of truth: scripts/gates/templates/ (portable copies of AO workflows).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-gates.sh [options] <target-repo-root>

  Copies portable workflow templates into <target-repo-root>/.github/workflows/:
    - skeptic-gate.yml   (deterministic gates 1–6; optional CodeRabbit skip)
    - evidence-gate.yml  (PR body ## Evidence bundle validation)

Options:
  --dry-run    Print actions only; do not write files
  -h, --help   Show this help

After install (GitHub UI or gh CLI):
  • Add branch protection required checks: "Skeptic Gate", "Evidence Gate" (exact names)
  • Optional repository variables:
      SKEPTIC_REQUIRED_CHECK_NAMES              comma-separated check-run names (default: test)
      SKEPTIC_REQUIRE_CODERABBIT                false = skip CodeRabbit gate
      SKEPTIC_REQUIRE_INLINE_THREADS_RESOLVED   false = skip review-thread gate (noisy bots)

Docs: agent-orchestrator scripts/gates/ (this directory)
EOF
}

DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *) break ;;
  esac
done

if [ $# -lt 1 ]; then
  usage >&2
  exit 1
fi

TARGET=$(cd "$1" && pwd)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATES="$SCRIPT_DIR/templates"
DEST="$TARGET/.github/workflows"

for f in skeptic-gate.yml evidence-gate.yml; do
  if [ ! -f "$TEMPLATES/$f" ]; then
    echo "ERROR: missing template $TEMPLATES/$f" >&2
    exit 1
  fi
done

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] would mkdir -p $DEST"
  echo "[dry-run] would cp $TEMPLATES/skeptic-gate.yml $TEMPLATES/evidence-gate.yml -> $DEST/"
  exit 0
fi

mkdir -p "$DEST"
cp "$TEMPLATES/skeptic-gate.yml" "$TEMPLATES/evidence-gate.yml" "$DEST/"

echo "Installed:"
echo "  $DEST/skeptic-gate.yml"
echo "  $DEST/evidence-gate.yml"
echo ""
echo "Next: commit these files, push, then configure branch protection + optional repo variables (see --help)."
