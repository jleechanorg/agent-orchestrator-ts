#!/bin/bash
# ao-gc.sh — Periodic AO stale worktree + orphan tmux GC
#
# Scans ~/.worktrees/<project>/ for session-named worktrees with no active
# tmux session. Reports stale entries; removes them only when run manually
# in a human terminal (not via Claude Bash tool).
#
# HUMAN-ONLY LIVE MODE:
#   Agents are blocked from running `git worktree remove/prune` by the
#   protect-worktrees.sh PreToolUse hook. This script respects that guard:
#   live mode (--fix) requires AO_GC_FIX=1 env var to be set, which cannot
#   be done through the Claude Bash tool's environment restrictions.
#
# Usage:
#   scripts/ao-gc.sh                     # dry-run scan
#   AO_GC_FIX=1 scripts/ao-gc.sh        # remove stale entries (human terminal only)
#   scripts/ao-gc.sh --project agent-orchestrator
#
# Session name pattern enforced: ^(ao|jc|wa|cc|ra|wc)-[0-9]+$
# Anything else (worktree_worker*, main, etc.) is ALWAYS skipped.
set -euo pipefail

TARGET_PROJECT=""
WORKTREES_BASE="${HOME}/.worktrees"
MAIN_REPO="${MAIN_REPO:-$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null || echo '')}"

# Parse args (always dry-run; live mode requires AO_GC_FIX=1 env var)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      shift
      if [ "$#" -eq 0 ] || [[ "$1" == --* ]]; then
        echo "ERROR: --project requires a value" >&2; exit 1
      fi
      TARGET_PROJECT="$1"
      ;;
    --project=*) TARGET_PROJECT="${1#--project=}" ;;
    -*)
      echo "ERROR: unknown flag: $1" >&2; exit 1
      ;;
    *) echo "ERROR: unexpected positional: $1" >&2; exit 1 ;;
  esac
  shift
done

# Live mode requires AO_GC_FIX=1 — this env var cannot be set via Claude Bash tool,
# making it impossible for agents to trigger live removal even if they invoke this script.
LIVE_MODE=false
if [ -n "${AO_GC_FIX:-}" ]; then
  case "$AO_GC_FIX" in
    1|t|true|yes) LIVE_MODE=true ;;
    *) echo "ERROR: AO_GC_FIX must be 1 (got '$AO_GC_FIX')" >&2; exit 1 ;;
  esac
fi

SESSION_PATTERN='^(ao|jc|wa|cc|ra|wc)-[0-9]+$'
STALE=0
SKIPPED=0
REMOVED=0

echo "=== ao-gc.sh — $(date '+%Y-%m-%d %H:%M:%S') ==="
echo "Mode: $([ "$LIVE_MODE" = true ] && echo 'LIVE' || echo 'DRY RUN')"
echo ""

# Fail-closed preflight: verify tmux is available before live mode
if [ "$LIVE_MODE" = true ]; then
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

    # Check tmux session — tmux sessions are named just <session_name> (no namespace prefix)
    if tmux has-session -t "$session_name" 2>/dev/null; then
      echo "ACTIVE: $project/$session_name"
    else
      echo "STALE:  $project/$session_name  (no tmux session)"
      ((STALE++)) || true
      if [ "$LIVE_MODE" = true ]; then
        # Use git worktree remove from main repo if path is registered there;
        # fall back to rm -rf only for unregistered worktrees.
        wt_path_clean="${wt_path%/}"
        removed=false
        if [ -n "$MAIN_REPO" ] && git -C "$MAIN_REPO" worktree list 2>/dev/null | grep -qF "$wt_path_clean"; then
          if git -C "$MAIN_REPO" worktree remove --force "$wt_path_clean" 2>/dev/null; then
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

# 2. Also prune git worktree metadata for dead paths (main repo only)
if [ -n "$MAIN_REPO" ] && [ "$LIVE_MODE" = true ]; then
  echo "Running git worktree prune on $MAIN_REPO..."
  git -C "$MAIN_REPO" worktree prune
fi

echo "Done."
