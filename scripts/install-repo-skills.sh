#!/bin/bash
# Install repo-bundled AO skills into user skill directories.

set -euo pipefail

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SOURCE_SKILL_DIR="$REPO_ROOT/skills/agent-orchestrator"

if [ ! -d "$SOURCE_SKILL_DIR" ]; then
  echo "WARNING: Repo skill not found at $SOURCE_SKILL_DIR"
  exit 0
fi

install_skill_link() {
  local target_root="$1"
  local target="$target_root/agent-orchestrator"

  mkdir -p "$target_root"

  if [ -L "$target" ]; then
    ln -sfn "$SOURCE_SKILL_DIR" "$target"
    echo "[ok] Updated skill link: $target"
    return
  fi

  if [ -e "$target" ]; then
    echo "WARNING: Skipping existing non-symlink skill path: $target"
    return
  fi

  ln -s "$SOURCE_SKILL_DIR" "$target"
  echo "[ok] Installed skill: $target"
}

install_skill_link "$HOME/.claude/skills"
install_skill_link "$HOME/.codex/skills"
