#!/bin/bash
# ao-gc.sh — Periodic AO stale worktree + orphan tmux GC
#
# Sweeps ~/.worktrees/<project>/ for session-named worktrees with no active
# tmux session. Safe to run at any time; never removes non-session-named paths.
#
# HUMAN-ONLY SCRIPT: must be run manually in a terminal, never by an agent.
# Agents are blocked from running `git worktree remove/prune` by the
# protect-worktrees.sh hook. This script is exempt because it runs outside
# the Bash tool context, but it must only be invoked by a human.
#
# Usage:
#   scripts/ao-gc.sh                     # dry-run (default)
#   scripts/ao-gc.sh --fix               # actually remove stale entries
#   scripts/ao-gc.sh --project agent-orchestrator --fix
#   scripts/ao-gc.sh --project agent-orchestrator --fix --tmux-prefix bb5e6b7f8db3
#
# Session name pattern enforced: ^(ao|jc|wa|cc|ra|wc)-[0-9]+$
# Anything else (worktree_worker*, main, etc.) is ALWAYS skipped.
set -euo pipefail

DRY_RUN=true
TARGET_PROJECT=""
TMUX_PREFIX="${AO_TMUX_PREFIX:-bb5e6b7f8db3}"
WORKTREES_BASE="${HOME}/.worktrees"
MAIN_REPO="${MAIN_REPO:-$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null || echo '')}"

# Parse args — fail fast on unknown flags or missing values
SKIP_NEXT=false
for arg in "$@"; do
  if [ "$SKIP_NEXT" = true ]; then
    SKIP_NEXT=false
    continue
  fi
  case "$arg" in
    --fix) DRY_RUN=false ;;
    --project)
      SKIP_NEXT=true  # next token is the project name — handled via shift-style below
      ;;
    --tmux-prefix)
      SKIP_NEXT=true
      ;;
    --project=*) TARGET_PROJECT="${arg#--project=}" ;;
    --tmux-prefix=*) TMUX_PREFIX="${arg#--tmux-prefix=}" ;;
    -*)
      echo "ERROR: unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      # Bare value after --project or --tmux-prefix
      TARGET_PROJECT="$arg"
      ;;
  esac
done

# Re-parse with positional awareness for --project <value> and --tmux-prefix <value>
DRY_RUN=true
TARGET_PROJECT=""
TMUX_PREFIX="${AO_TMUX_PREFIX:-bb5e6b7f8db3}"
i=1
while [ $i -le $# ]; do
  arg="${!i}"
  case "$arg" in
    --fix) DRY_RUN=false ;;
    --project)
      i=$((i+1))
      if [ $i -gt $# ] || [[ "${!i}" == --* ]]; then
        echo "ERROR: --project requires a value" >&2; exit 1
      fi
      TARGET_PROJECT="${!i}"
      ;;
    --project=*) TARGET_PROJECT="${arg#--project=}" ;;
    --tmux-prefix)
      i=$((i+1))
      if [ $i -gt $# ] || [[ "${!i}" == --* ]]; then
        echo "ERROR: --tmux-prefix requires a value" >&2; exit 1
      fi
      TMUX_PREFIX="${!i}"
      ;;
    --tmux-prefix=*) TMUX_PREFIX="${arg#--tmux-prefix=}" ;;
    -*)
      echo "ERROR: unknown flag: $arg" >&2; exit 1
      ;;
  esac
  i=$((i+1))
done

SESSION_PATTERN='^(ao|jc|wa|cc|ra|wc)-[0-9]+$'
STALE=0
SKIPPED=0
REMOVED=0

echo "=== ao-gc.sh — $(date '+%Y-%m-%d %H:%M:%S') ==="
echo "Mode: $([ "$DRY_RUN" = true ] && echo 'DRY RUN (pass --fix to remove)' || echo 'LIVE')"
echo "TMUX_PREFIX: $TMUX_PREFIX"
echo ""

# Fail-closed preflight: verify tmux is available before live mode
if [ "$DRY_RUN" = false ]; then
  if ! command -v tmux >/dev/null 2>&1; then
    echo "ERROR: tmux not found in PATH — refusing to run in live mode (would mark all sessions stale)" >&2
    exit 1
  fi
  if ! tmux list-sessions >/dev/null 2>&1; then
    echo "ERROR: tmux server not running — refusing to run in live mode (would mark all sessions stale)" >&2
    exit 1
  fi
fi

# 1. Sweep ~/.worktrees/<project>/<session> paths
for project_dir in "$WORKTREES_BASE"/*/; do
  [ -d "$project_dir" ] || continue
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
        # Use git worktree remove from main repo if path is registered
        removed=false
        if [ -n "$MAIN_REPO" ] && git -C "$MAIN_REPO" worktree list 2>/dev/null | grep -qF "$wt_path"; then
          if git -C "$MAIN_REPO" worktree remove --force "$wt_path" 2>/dev/null; then
            echo "  → removed via git worktree remove"
            removed=true
          fi
        fi
        if [ "$removed" = false ]; then
          rm -rf "$wt_path"
          echo "  → removed via rm -rf"
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
