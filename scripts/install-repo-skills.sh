#!/bin/bash
# Install repo-bundled AO skills into user skill directories.

set -euo pipefail

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SOURCE_SKILLS_DIR="$REPO_ROOT/skills"

if [ ! -d "$SOURCE_SKILLS_DIR" ]; then
  echo "WARNING: Repo skills directory not found at $SOURCE_SKILLS_DIR"
  exit 0
fi

install_skill_links() {
  local target_root="$1"
  mkdir -p "$target_root"

  # Loop over all subdirectories in skills/
  for skill_path in "$SOURCE_SKILLS_DIR"/*/; do
    [ -d "$skill_path" ] || continue
    local skill_name
    skill_name=$(basename "$skill_path")
    local target="$target_root/$skill_name"

    local skill_dir="${skill_path%/}"

    if [ -L "$target" ]; then
      ln -sfn "$skill_dir" "$target"
      echo "[ok] Updated skill link: $target"
      continue
    fi

    if [ -e "$target" ]; then
      echo "WARNING: Skipping existing non-symlink skill path: $target"
      continue
    fi

    ln -s "$skill_dir" "$target"
    echo "[ok] Installed skill: $target"
  done
}

install_skill_links "$HOME/.claude/skills"
install_skill_links "$HOME/.codex/skills"
