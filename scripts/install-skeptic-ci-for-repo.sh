#!/usr/bin/env bash
# Install skeptic-gate.yml and/or skeptic-cron.yml into any GitHub repo checkout.
#
# This mirrors `ao skeptic install` (packages/cli) but needs only bash + curl + git —
# useful for consumer repos that do not have the AO monorepo or global `ao` CLI.
#
# Templates are the canonical copies under packages/cli/src/templates/skeptic/ on
# jleechanorg/agent-orchestrator (trigger + polling in GHA; ao skeptic verify runs
# on a machine running lifecycle-manager with gh auth — no LLM API keys in GHA).
#
# Usage:
#   ./scripts/install-skeptic-ci-for-repo.sh              # installs both (default)
#   ./scripts/install-skeptic-ci-for-repo.sh --gate --force
#   ./scripts/install-skeptic-ci-for-repo.sh --minimal    # skeptic-gate.yml only (lifecycle-worker primary, no GHA cron)
#   ./scripts/install-skeptic-ci-for-repo.sh --gate --cron  # gate + hourly cron backup
#   SKEPTIC_CI_REF=my-branch ./scripts/install-skeptic-ci-for-repo.sh
#
# From another repo: download, inspect, then run (do not pipe curl straight to bash):
#   curl -fsSL "https://raw.githubusercontent.com/jleechanorg/agent-orchestrator/main/scripts/install-skeptic-ci-for-repo.sh" -o /tmp/install-skeptic-ci-for-repo.sh
#   less /tmp/install-skeptic-ci-for-repo.sh   # or your editor
#   bash /tmp/install-skeptic-ci-for-repo.sh
#
set -euo pipefail

REPO_DEFAULT="jleechanorg/agent-orchestrator"
REF_DEFAULT="main"
TEMPLATE_PREFIX="packages/cli/src/templates/skeptic"

SKEPTIC_CI_REPO="${SKEPTIC_CI_REPO:-$REPO_DEFAULT}"
SKEPTIC_CI_REF="${SKEPTIC_CI_REF:-$REF_DEFAULT}"

INSTALL_GATE=false
INSTALL_CRON=false
FORCE=false
MINIMAL=false
ALL=false

usage() {
  echo "Usage: $0 [--gate] [--cron] [--all] [--minimal] [--force]"
  echo "  (no flags)  Install both workflows (same as --all)"
  echo "  --minimal  Install only skeptic-gate.yml (thin polling; lifecycle-worker is primary eval)"
  echo "  --gate     Install only skeptic-gate.yml"
  echo "  --cron     Install only skeptic-cron.yml (GHA cron as backup catchup)"
  echo "  --all      Install both workflows"
  echo "  --force    Overwrite existing workflow files"
  echo ""
  echo "The --minimal mode is the recommended setup: skeptic-gate.yml polls for VERDICT"
  echo "while lifecycle-worker runs ao skeptic verify and posts the actual VERDICT."
  echo "The GHA cron (--cron) is an optional hourly backup catchup."
  echo ""
  echo "Environment:"
  echo "  SKEPTIC_CI_REPO  GitHub owner/repo for templates (default: $REPO_DEFAULT)"
  echo "  SKEPTIC_CI_REF   Branch or tag (default: $REF_DEFAULT)"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate) INSTALL_GATE=true ;;
    --cron) INSTALL_CRON=true ;;
    --all) ALL=true; INSTALL_GATE=true; INSTALL_CRON=true ;;
    --minimal) MINIMAL=true; INSTALL_GATE=true ;;
    --force) FORCE=true ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
  shift
done

# --minimal is exclusive: it enables gate-only mode; reject conflicting combinations.
if [[ "$MINIMAL" == true && ( "$INSTALL_CRON" == true || "$ALL" == true ) ]]; then
  echo "ERROR: --minimal can't be combined with --cron or --all (--minimal already enables gate-only mode)" >&2
  usage 1
fi

# Default: install both when neither --gate nor --cron was given (matches installer expectation).
if [[ "$INSTALL_GATE" == false && "$INSTALL_CRON" == false ]]; then
  INSTALL_GATE=true
  INSTALL_CRON=true
fi

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required" >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || true
if [[ -z "${ROOT:-}" ]]; then
  echo "ERROR: not inside a git repository" >&2
  exit 1
fi

WF_DIR="${ROOT}/.github/workflows"
mkdir -p "$WF_DIR"

base_url="https://raw.githubusercontent.com/${SKEPTIC_CI_REPO}/${SKEPTIC_CI_REF}/${TEMPLATE_PREFIX}"

fetch_install() {
  local name="$1"
  local dst="${WF_DIR}/${name}"
  if [[ -f "$dst" && "$FORCE" != true ]]; then
    echo "SKIP: $dst exists (use --force to overwrite)"
    return 0
  fi
  echo "FETCH $base_url/$name -> $dst"
  if ! curl -fsSL "${base_url}/${name}" -o "$dst"; then
    echo "ERROR: failed to fetch $name from ${base_url}/${name}" >&2
    echo "       Check SKEPTIC_CI_REPO ($SKEPTIC_CI_REPO) and SKEPTIC_CI_REF ($SKEPTIC_CI_REF)" >&2
    rm -f "$dst"
    return 1
  fi
  echo "OK   $name"
}

if [[ "$INSTALL_GATE" == true ]]; then
  fetch_install "skeptic-gate.yml"
fi
if [[ "$INSTALL_CRON" == true ]]; then
  fetch_install "skeptic-cron.yml"
fi

echo ""
echo "Next steps:"
echo "  1. Review diffs: git diff .github/workflows/skeptic-*.yml"
echo "  2. Commit and push to enable Actions."
echo "  3. Ensure lifecycle-manager is running on a host with \`gh\` auth + \`ao skeptic verify\`."
echo "     The lifecycle-worker is the primary eval engine; skeptic-gate.yml just polls."
echo "     After any AO install/update, run \`ao doctor\` and confirm zero FAIL before spawning workers."
echo "  4. Optional (if --cron was used): skeptic-cron.yml runs hourly as backup catchup."
echo "  5. Optional: re-run a stuck gate via Actions → Skeptic Gate → Run workflow."
echo ""
