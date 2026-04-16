#!/bin/bash
# Install repo-bundled AO skills into user skill directories.

set -euo pipefail

REPO_ROOT="${AO_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SOURCE_SKILLS_DIR="$REPO_ROOT/skills"

if [ ! -d "$SOURCE_SKILLS_DIR" ]; then
  echo "WARNING: Repo skills directory not found at $SOURCE_SKILLS_DIR"
  exit 0
fi

install_skill_link() {
  local source_dir="$1"
  local target_root="$2"
  local skill_name
  skill_name="$(basename "${source_dir%/}")"
  local target="$target_root/$skill_name"

  mkdir -p "$target_root"

  if [ -L "$target" ]; then
    ln -sfn "$source_dir" "$target"
    echo "[ok] Updated skill link: $target"
    return
  fi

  if [ -e "$target" ]; then
    echo "WARNING: Skipping existing non-symlink skill path: $target"
    return
  fi

  ln -s "$source_dir" "$target"
  echo "[ok] Installed skill: $target"
}

# Install all skills from the repo's skills/ directory into user skill dirs
for skill_dir in "$SOURCE_SKILLS_DIR"/*/; do
  if [ -d "$skill_dir" ]; then
    install_skill_link "$skill_dir" "$HOME/.claude/skills"
  fi
done

# Also install into Codex user skills directory
for skill_dir in "$SOURCE_SKILLS_DIR"/*/; do
  if [ -d "$skill_dir" ]; then
    install_skill_link "$skill_dir" "$HOME/.codex/skills"
  fi
done
