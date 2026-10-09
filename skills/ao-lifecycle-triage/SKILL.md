---
name: ao-lifecycle-triage
description: Use when AO lifecycle backfill cannot claim a PR because git reports a branch is already checked out in the main repository or a stale worktree.
---

# AO Lifecycle Backfill Claim Failure Triage

## When to use

When `lifecycle.backfill.claim_failed` errors appear in the lifecycle-worker log with:
`fatal: refusing to fetch into branch 'refs/heads/BRANCH' checked out at 'PATH'`

## Two distinct root causes (same error surface)

### Cause A: Main repo on wrong branch

**Symptom**: The path reported by git is the configured main repository.
**Diagnosis**: Copy that exact path into `REPO_ROOT`, verify it against the AO
project configuration, then inspect its branch, status, and owner:

```bash
: "${REPO_ROOT:?Set the verified repository path from the error and project configuration}"
git -C "$REPO_ROOT" branch --show-current
git -C "$REPO_ROOT" status --short
git -C "$REPO_ROOT" worktree list --porcelain
```

**Fix**: Only after the existing owner releases the checkout, all work is committed
or otherwise preserved, and the checkout is clean, switch to its configured base
branch (usually `main`) and update with `git pull --ff-only`. Do not reset, stash,
discard changes, or move an active owner's branch to make a claim succeed.

**Why it happens**: An AO agent or manual workflow left a feature branch checked
out in the main repository. This error alone does not prove that work is abandoned.

### Cause B: Ghost worktrees (dead AO worktrees with branches still checked out)

**Symptom**: The reported path is a registered linked worktree.
**Diagnosis**:

1. Match the exact path and branch in `git worktree list --porcelain`.
2. Resolve its existing AO session metadata: project, session ID, workspace path,
   runtime handle, and PR. Do not infer identity from a tmux prefix or directory name.
3. Verify the recorded runtime and agent processes are dead and the owner has
   released the work. Idle metadata, a missing tmux name, or elapsed time alone
   does not prove a dead session, particularly for non-tmux runtimes.
4. Inspect the worktree for staged, unstaged, untracked, and unpublished work.
   Preserve it and hold cleanup if ownership or work preservation is uncertain.

**Fix**: For a confirmed dead, released session whose work is preserved, use the
AO session manager so metadata and the associated workspace are cleaned together:

```bash
: "${SESSION_ID:?Resolve the existing session ID from AO metadata first}"
ao session kill "$SESSION_ID" --keep-session
```

Verify the session is no longer active and the exact worktree is no longer
registered. A cleanup error remains a blocker; do not fall back to a raw runtime
kill. If no AO record exists, obtain explicit ownership release and preservation
proof before considering normal `git worktree remove "$WORKTREE_PATH"`. A dirty
worktree refusal is a reason to stop, not to force removal.

**Why it happens**: A prior runtime stopped without completing managed cleanup.
Inspect the deployed lifecycle policy rather than assuming a fixed orphan TTL.

## Triage order (always check A first)

1. Look at the path in the error: if it's the main repo path → Cause A
2. If git identifies it as a linked worktree → Cause B, regardless of its location
3. If backfill is aborted (`claim_failed_abort` after 3 consecutive failures), check both

## Prevention

- Use isolated worktrees and AO-managed cleanup; preserve owner/session linkage.
- Restore the configured base branch only in a clean, released main checkout.
- Diagnose recurring orphan cleanup from actual metadata and lifecycle logs;
  changing TTLs or restarting services is a separate operational decision.
