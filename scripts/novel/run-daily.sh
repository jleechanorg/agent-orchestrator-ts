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
  echo "       Run against the canonical main repo (resolved: $_repo_root)." >&2
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
      echo "       Install Node 22 via nvm, or create $_repo_root/.nvm-node symlink." >&2
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

# Sync to latest origin/main before making changes.
git -C "$_repo_root" fetch origin main
git -C "$_repo_root" merge --ff-only origin/main

# Push helper: retries once with fetch+rebase if non-ff rejection occurs
# (edge case: concurrent push between our merge and push in a multi-instance scenario)
push_with_retry() {
  if git push origin main; then
    return 0
  fi
  echo "run-daily.sh: push rejected (non-ff), fetching and rebasing..." >&2
  git fetch origin main
  if git rebase origin/main; then
    git push origin main
  else
    echo "run-daily.sh: FATAL: rebase failed — resetting to origin/main." >&2
    git rebase --abort 2>/dev/null
    git reset --hard origin/main
    return 1
  fi
}

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

  # Idempotency: skip if neither file has changes.  Workers changes matter only
  # if it exists (created by a prior generator run).
  # FIX: git ls-files --error-unmatch detects untracked files (git diff returns 0 for untracked).
  _changed=false
  if git ls-files --error-unmatch "$DAILY_FILE" 2>/dev/null; then
    # File is tracked — use diff for change detection.
    if ! git diff --quiet "$DAILY_FILE" 2>/dev/null; then
      _changed=true
    fi
  elif [ -f "$DAILY_FILE" ]; then
    # File is untracked but exists — new entry created.
    _changed=true
  fi
  if [ "$_changed" != "true" ] && [ -f "$WORKERS_FILE" ] && ! git diff --quiet "$WORKERS_FILE" 2>/dev/null; then
    _changed=true
  fi

  if [ "$_changed" != "true" ]; then
    echo "run-daily.sh: no changes to commit — skipping."
  else
    # FIX: check for pre-existing staged changes before adding our files,
    # preventing unrelated staged content from being swept into the automated commit.
    if ! git diff --cached --quiet 2>/dev/null; then
      echo "ERROR: run-daily.sh: pre-existing staged changes detected; refusing to auto-commit from dirty index." >&2
      echo "       Unstage with: git -C $_repo_root reset HEAD" >&2
      exit 1
    fi
    git add "$DAILY_FILE"
    [ -f "$WORKERS_FILE" ] && git add "$WORKERS_FILE"
    git -c user.name="ao-novel-daily" -c user.email="ao-novel-daily@agentorchestrator" \
      commit -m "[agento] novel: daily entry $TODAY"
    push_with_retry || exit 1
    echo "run-daily.sh: pushed entry to origin/main."
  fi
else
  echo "run-daily.sh: WARNING: $DAILY_FILE not created — skipping commit/push." >&2
fi
