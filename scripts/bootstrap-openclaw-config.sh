#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/ao-config-topology.sh
source "$SCRIPT_DIR/lib/ao-config-topology.sh"

FORCE=false
LINK_TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=true
      ;;
    --link-legacy-aliases)
      if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == -* ]]; then
        printf 'Missing value for --link-legacy-aliases (expected staging|production)\n' >&2
        exit 1
      fi
      LINK_TARGET="$2"
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/bootstrap-openclaw-config.sh [--force] [--link-legacy-aliases staging|production]

Creates the managed OpenClaw/AO config directories, bootstraps a staging config
at ~/.openclaw/agent-orchestrator.yaml when missing, and leaves production
(~/.openclaw_prod/agent-orchestrator.yaml) untouched until an explicit promote.
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

STAGING_CONFIG="$(ao_staging_config_path)"
PRODUCTION_CONFIG="$(ao_production_config_path)"
mkdir -p "$(dirname "$STAGING_CONFIG")" "$(dirname "$PRODUCTION_CONFIG")"
mkdir -p "${HOME}/.openclaw/logs" "${HOME}/.openclaw_prod/logs"

if [ "$FORCE" != true ] && [ -f "$STAGING_CONFIG" ]; then
  ao_validate_topology
fi

if [ ! -f "$STAGING_CONFIG" ] || [ "$FORCE" = true ]; then
  rm -f "$STAGING_CONFIG"
  cat >"$STAGING_CONFIG" <<'EOF'
# Managed staging configuration for Agent Orchestrator / OpenClaw.
# This file is safe to edit locally. Promote validated changes into production
# with scripts/promote-openclaw-config.sh.
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects: {}
EOF
  chmod 600 "$STAGING_CONFIG"
  echo "Bootstrapped staging config: $STAGING_CONFIG"
else
  echo "Staging config already present: $STAGING_CONFIG"
fi

"$REPO_ROOT/scripts/validate-config.sh" "$STAGING_CONFIG"

if [ -n "$LINK_TARGET" ]; then
  case "$LINK_TARGET" in
    staging)
      LINK_SOURCE="$STAGING_CONFIG"
      ;;
    production)
      LINK_SOURCE="$PRODUCTION_CONFIG"
      ;;
    *)
      printf 'Invalid value for --link-legacy-aliases: %s\n' "$LINK_TARGET" >&2
      exit 1
      ;;
  esac

  if [ ! -f "$LINK_SOURCE" ]; then
    printf 'Refusing to link legacy aliases to missing target: %s\n' "$LINK_SOURCE" >&2
    exit 1
  fi

  while IFS= read -r alias_path; do
    mkdir -p "$(dirname "$alias_path")"
    if [ -e "$alias_path" ] && [ ! -L "$alias_path" ]; then
      echo "Skipping existing non-symlink alias path: $alias_path"
      continue
    fi
    rm -f "$alias_path"
    ln -s "$LINK_SOURCE" "$alias_path"
    echo "Linked legacy alias: $alias_path -> $LINK_SOURCE"
  done < <(ao_legacy_alias_paths)
fi

echo "Production config remains separate at: $PRODUCTION_CONFIG"
