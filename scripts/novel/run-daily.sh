#!/bin/bash
# Launchd-compatible wrapper for the novel daily aggregation.
# Computes today's date at runtime so each run writes novel/workers/{YYYY-MM-DD}.md.
#
# Called by: ~/Library/LaunchAgents/ai.agento.novel-daily.plist
# Installed by: scripts/setup-launchd.sh novel
#
# Canonical path: agent-orchestrator/scripts/novel/run-daily.sh
set -euo pipefail

# Resolve REPO_ROOT from this script's location (stable regardless of worktree)
_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Guard: this script must run against the canonical main repo on main branch.
# AO worktrees (name matching ^ao-[0-9]+$) may be removed when sessions end — do not use them.
_repo_branch="$(git -C "$_repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [ "$_repo_branch" != "main" ]; then
  echo "ERROR: run-daily.sh: repo is on branch '$_repo_branch', expected 'main'. Refusing to push." >&2
  echo "       Run against /Users/jleechan/project_agento/agent-orchestrator (the canonical main repo)." >&2
  exit 1
fi

if [ ! -f "$_repo_root/scripts/novel/generate-daily-entry.mjs" ]; then
  echo "ERROR: run-daily.sh: generate-daily-entry.mjs not found in $_repo_root/scripts/novel/" >&2
  exit 1
fi

# Prefer nvm Node 22 — Homebrew node may be v24 with incompatible native module ABI
# (better-sqlite3: modules=137 vs 127 causes runtime crashes).
# Scan all v22.* versions and verify the major version is 22 before using.
NODE=""
if [ -x "$_repo_root/.nvm-node" ]; then
  _ver="$("$_repo_root/.nvm-node" --version 2>/dev/null || echo "")"
  if [[ "$_ver" =~ ^v22\. ]]; then
    NODE="$_repo_root/.nvm-node"
  fi
fi

if [ -z "$NODE" ]; then
  for _nvm_node in "$HOME"/.nvm/versions/node/v22.*/bin/node; do
    [ -x "$_nvm_node" ] || continue
    _ver="$("$_nvm_node" --version 2>/dev/null || echo "")"
    if [[ "$_ver" =~ ^v22\. ]]; then
      NODE="$_nvm_node"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  _sys_node="$(command -v node 2>/dev/null || echo "")"
  if [ -n "$_sys_node" ] && [ -x "$_sys_node" ]; then
    _ver="$("$_sys_node" --version 2>/dev/null || echo "")"
    if [[ "$_ver" =~ ^v22\. ]]; then
      NODE="$_sys_node"
    else
      echo "ERROR: run-daily.sh: system node is '$_ver' (not v22); refusing to run." >&2
      echo "       Install Node 22 via nvm, or create \$REPO_ROOT/.nvm-node symlink." >&2
      exit 1
    fi
  else
    echo "ERROR: run-daily.sh: no node binary found" >&2
    exit 1
  fi
fi

# Date computed at runtime, not at plist-install time
TODAY="$(date '+%Y-%m-%d')"
WORKERS_FILE="$_repo_root/novel/the-daily-lives-of-workers.md"

"$NODE" "$_repo_root/scripts/novel/generate-daily-entry.mjs" \
  --daily "$TODAY" \
  --file "$WORKERS_FILE" \
  --days 1 \
  --words 1000

# Commit and push the new daily entry to origin/main.
# Uses a dedicated "novel-daily" identity so these commits are distinguishable.
DAILY_FILE="$_repo_root/novel/workers/${TODAY}.md"
if [ -f "$DAILY_FILE" ]; then
  cd "$_repo_root"
  git config user.name "ao-novel-daily" 2>/dev/null || true
  git config user.email "ao-novel-daily@agentorchestrator" 2>/dev/null || true

  # Determine whether this is a new file or a changed tracked file.
  if git ls-files --error-unmatch "$DAILY_FILE" >/dev/null 2>&1; then
    # Tracked file: skip if working tree matches index (already committed).
    if git diff --quiet "$DAILY_FILE" 2>/dev/null; then
      echo "run-daily.sh: $DAILY_FILE unchanged (already committed) — skipping."
    else
      git add "$DAILY_FILE" "$_repo_root/novel/the-daily-lives-of-workers.md"
      git commit -m "[agento] novel: daily entry $TODAY"
      git push origin main
      echo "run-daily.sh: pushed updated entry to origin/main."
    fi
  else
    # New untracked file: add, commit, push.
    git add "$DAILY_FILE" "$_repo_root/novel/the-daily-lives-of-workers.md"
    git commit -m "[agento] novel: daily entry $TODAY"
    git push origin main
    echo "run-daily.sh: pushed new daily entry to origin/main."
  fi
else
  echo "run-daily.sh: WARNING: $DAILY_FILE not created — skipping commit/push." >&2
fi
