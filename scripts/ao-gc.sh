#!/bin/bash
# ao-gc.sh — Periodic AO stale worktree + orphan tmux GC
#
# Sweeps ~/.worktrees/<project>/ for session-named worktrees with no active
# tmux session. Safe to run at any time; never removes non-session-named paths.
#
# Usage:
#   scripts/ao-gc.sh                     # dry-run (default)
#   scripts/ao-gc.sh --fix               # actually remove stale entries
#   scripts/ao-gc.sh --project agent-orchestrator --fix
#
# Session name pattern enforced: ^(ao|jc|wa|cc|ra|wc)-[0-9]+$
# Anything else (worktree_worker*, main, etc.) is ALWAYS skipped.
set -euo pipefail

DRY_RUN=true
TARGET_PROJECT=""
TMUX_PREFIX="${AO_TMUX_PREFIX:-bb5e6b7f8db3}"
WORKTREES_BASE="${HOME}/.worktrees"
MAIN_REPO="${MAIN_REPO:-$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null || echo '')}"

for arg in "$@"; do
  case "$arg" in
    --fix) DRY_RUN=false ;;
    --project) ;;
    *) TARGET_PROJECT="$arg" ;;
  esac
done

SESSION_PATTERN='^(ao|jc|wa|cc|ra|wc)-[0-9]+$'
STALE=0
SKIPPED=0
REMOVED=0

echo "=== ao-gc.sh — $(date '+%Y-%m-%d %H:%M:%S') ==="
echo "Mode: $([ "$DRY_RUN" = true ] && echo 'DRY RUN (pass --fix to remove)' || echo 'LIVE')"
echo ""

# 1. Sweep ~/.worktrees/<project>/<session> paths
for project_dir in "$WORKTREES_BASE"/*/; do
  project=$(basename "$project_dir")
  [ -n "$TARGET_PROJECT" ] && [ "$project" != "$TARGET_PROJECT" ] && continue

  for wt_path in "$project_dir"*/; do
    [ -d "$wt_path" ] || continue
    session_name=$(basename "$wt_path")

    # Guard: skip non-session-named worktrees unconditionally
    if ! echo "$session_name" | grep -qE "$SESSION_PATTERN"; then
      echo "SKIP (non-session): $project/$session_name"
      ((SKIPPED++)) || true
      continue
    fi

    tmux_name="${TMUX_PREFIX}-${session_name}"
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
      echo "ACTIVE: $project/$session_name"
    else
      echo "STALE:  $project/$session_name  (no tmux session $tmux_name)"
      ((STALE++)) || true
      if [ "$DRY_RUN" = false ]; then
        # Use git worktree remove from main repo if available
        if [ -n "$MAIN_REPO" ] && git -C "$MAIN_REPO" worktree list 2>/dev/null | grep -q "$wt_path"; then
          git -C "$MAIN_REPO" worktree remove --force "$wt_path" 2>/dev/null && \
            echo "  → removed via git worktree" || \
            rm -rf "$wt_path" && echo "  → removed via rm -rf"
        else
          rm -rf "$wt_path" && echo "  → removed via rm -rf"
        fi
        ((REMOVED++)) || true
      fi
    fi
  done
done

echo ""
echo "Summary: stale=$STALE skipped=$SKIPPED removed=$REMOVED"

# 2. Also prune git worktree list for dead paths (main repo only)
if [ -n "$MAIN_REPO" ] && [ "$DRY_RUN" = false ]; then
  echo "Running git worktree prune on $MAIN_REPO..."
  git -C "$MAIN_REPO" worktree prune
fi

echo "Done."
