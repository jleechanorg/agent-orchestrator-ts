import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ObservabilityMetricName, type SessionManager, createCorrelationId } from "@jleechanorg/ao-core";

const execFileAsync = promisify(execFile);

const TMUX_TIMEOUT_MS = 5_000;

export async function listTmuxSessionsWithActivity(): Promise<
  Array<{ name: string; activityMs: number | null }>
> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}\t#{session_activity}"],
      { timeout: TMUX_TIMEOUT_MS },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, activityRaw] = line.split("\t");
        const activitySeconds = Number.parseInt(activityRaw ?? "", 10);
        return {
          name,
          activityMs: Number.isFinite(activitySeconds)
            ? activitySeconds * 1000
            : null,
        };
      });
  } catch {
    return [];
  }
}

// AO session short-ID pattern — mirrors the prefix+num capture from parseTmuxName.
// parseTmuxName accepts any [a-zA-Z0-9_-]+ prefix, so we use the same here.
// This avoids hardcoding a fixed prefix list (which would miss custom sessionPrefixes).
export const AO_SESSION_PATTERN = /^[a-zA-Z0-9_-]+-\d+$/;

interface WorktreeObserver {
  recordOperation(opts: {
    metric: ObservabilityMetricName;
    operation: string;
    outcome: "success" | "failure" | "info";
    correlationId: string;
    projectId: string;
    data: Record<string, unknown>;
    level: "debug" | "info" | "warn" | "error";
    reason?: string;
  }): void;
}

/**
 * Remove git worktrees for AO sessions whose tmux session is dead and that are
 * no longer tracked in the AO session DB. Prevents "refusing to fetch into checked-out
 * branch" errors in backfillUncoveredPRs. (harness: ghost-worktree-sweep)
 */
// Exported for unit testing — prefer testing through the CLI command where possible
export async function sweepOrphanWorktrees(opts: {
  sessionManager: SessionManager;
  projectId: string;
  allProjectIds: string[];
  configHash: string;
  worktreeBaseDir: string;
  observer: WorktreeObserver;
}): Promise<void> {
  const {
    sessionManager,
    projectId,
    allProjectIds,
    configHash,
    worktreeBaseDir,
    observer,
  } = opts;
  const correlationId = createCorrelationId("lifecycle-worker");

  const allSessionGroups = await Promise.all(
    allProjectIds.map((pid) => sessionManager.list(pid)),
  );
  const activeRuntimeIds = new Set(
    allSessionGroups
      .flat()
      .map((s) => s.runtimeHandle?.id)
      .filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
  );

  // Build a set of AO session short-IDs (ao-749, jc-12, …) that have a live
  // tmux session under ANY config hash. Tmux session names follow the format
  // "${hash}-${sessionId}", e.g. "bb5e6b7f8db3-ao-749".
  //
  // Checking only ${configHash}-${entry} is insufficient: a second AO config
  // targeting the same projectId would create "${otherHash}-ao-749" whose
  // worktree is at the same path. Scanning all live sessions prevents
  // cross-config false-positive removal.
  const allTmuxSessions = await listTmuxSessionsWithActivity();
  // Fail-safe: if we cannot reach tmux at all, do not remove worktrees based on
  // an empty liveSessionIds set — a dead tmux daemon means we cannot reliably
  // determine which worktrees are in use. Skip this sweep cycle; the next run
  // (after tmux recovers) will perform the cleanup.
  if (allTmuxSessions.length === 0) return;

  const liveSessionIds = new Set<string>(
    allTmuxSessions
      .map((s) => {
        // Extract short session ID from tmux name: ${hash}-${prefix}-${num}.
        // Use permissive [a-zA-Z0-9_-]+ for prefix (matches parseTmuxName).
        const m = s.name.match(/^[a-f0-9]{12}-([a-zA-Z0-9_-]+-\d+)$/);
        return m ? m[1] : null;
      })
      .filter((id): id is string => id !== null),
  );

  // Worktrees live at <worktreeBaseDir>/<projectId>/<sessionId>/
  const projectWorktreeDir = join(worktreeBaseDir, projectId);
  let entries: string[];
  try {
    entries = readdirSync(projectWorktreeDir);
  } catch {
    // Worktree dir doesn't exist yet — nothing to sweep
    return;
  }

  let orphanCount = 0;
  let cleanedCount = 0;

  for (const entry of entries) {
    if (!AO_SESSION_PATTERN.test(entry)) continue;

    // Tmux session name: "{configHash}-{sessionId}" (e.g. "bb5e6b7f8db3-ao-749").
    // This is also the runtimeId used in the AO session DB for this config.
    const tmuxSessionName = `${configHash}-${entry}`;

    // Primary guard: AO DB knows about this session → it's managed, skip.
    if (activeRuntimeIds.has(tmuxSessionName)) continue;

    // Secondary guard: any live tmux session for this short ID (any config hash)
    // means the worktree is still in use — do not remove it.
    if (liveSessionIds.has(entry)) continue;

    const fullPath = join(worktreeBaseDir, projectId, entry);
    orphanCount += 1;
    try {
      // Double --force: the workspace-worktree plugin locks every worktree at creation
      // via `git worktree lock`. Ghost worktrees are precisely those that never had
      // `destroy()` called, so their lock is still held. Git requires --force --force
      // to remove a locked worktree.
      // cwd=fullPath: ensures git worktree remove discovers the main repo correctly even
      // when the lifecycle-worker process is not running from inside a git repository.
      await execFileAsync(
        "git",
        ["worktree", "remove", "--force", "--force", fullPath],
        { timeout: 15_000, cwd: fullPath },
      );
      cleanedCount += 1;
    } catch {
      // best-effort cleanup; continue with the rest
    }
  }

  if (orphanCount > 0) {
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.worktree_orphan_sweep",
      outcome: cleanedCount > 0 ? "success" : "failure",
      correlationId,
      projectId,
      data: { orphanCount, cleanedCount, projectWorktreeDir },
      level: cleanedCount > 0 ? "warn" : "error",
    });
  }
}
