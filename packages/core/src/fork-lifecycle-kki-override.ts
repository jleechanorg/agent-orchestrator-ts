/**
 * fork-lifecycle-kki-override — bd-kki companion module.
 *
 * When a session is marked "killed" by the runtime/workspace poller but the SCM
 * reports the associated PR has already been merged, this override upgrades the
 * session status to "merged" so the normal merged-handling path (bd-s4t.1) can
 * run its kill() call *after* exit proof validation rather than before it.
 *
 * This prevents two issues:
 * 1. Zombie tmux sessions: merged PR sessions left alive because lifecycle hit
 *    a killed transition before the SCM could confirm merge on the same poll.
 * 2. Status accuracy: the session is recorded as "merged" (not "killed") when
 *    the SCM confirms the PR was merged, reflecting the true terminal state.
 *
 * The SCM lookup is placed early in checkSession so that a transient SCM failure
 * causes the whole transition to be skipped — the session stays in its prior state
 * and is retried on the next poll cycle rather than being locked into "killed".
 */

import type { Session, OrchestratorConfig, PluginRegistry, SCM } from "./types.js";
import { PR_STATE } from "./types.js";

/**
 * Returns true if the session's PR is merged according to the SCM plugin.
 * Throws if the SCM call fails so the caller can skip state recording and retry.
 */
export async function isPRMerged(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<boolean> {
  if (!session.pr) return false;
  const project = config.projects[session.projectId];
  if (!project?.scm) return false;
  const scm = registry.get<SCM>("scm", project.scm.plugin);
  if (!scm) return false;
  const prState = await scm.getPRState(session.pr);
  return prState === PR_STATE.MERGED;
}
