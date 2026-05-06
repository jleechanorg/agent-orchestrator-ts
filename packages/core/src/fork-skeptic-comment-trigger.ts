/**
 * Fork: manual /skeptic comment trigger.
 *
 * Polls PR issue comments each tick, detects /skeptic from a non-bot human,
 * fires the skeptic-review reaction exactly once per comment (dedup by comment ID).
 */
import type { Session, OrchestratorConfig, PluginRegistry, SCM } from "./types.js";

type TriggerFn = (
  session: Session,
  lastSkepticSha: Map<string, string>,
  correlationId: string,
) => Promise<boolean>;

export async function detectAndTriggerSkepticComment(
  session: Session,
  processedCommentIds: Map<string, Set<number>>,
  lastSkepticSha: Map<string, string>,
  correlationId: string,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  triggerSkepticReaction: TriggerFn,
): Promise<void> {
  if (!session.pr) return;
  const project = config.projects[session.projectId];
  if (!project) return;
  const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm?.listPRComments) return;

  try {
    const comments = await scm.listPRComments(session.pr);
    for (const c of comments) {
      // Skip bot authors
      if (c.user.login.endsWith("[bot]")) continue;
      // Detect /skeptic at start of comment body
      if (!c.body.trimStart().startsWith("/skeptic")) continue;
      const seen = processedCommentIds.get(session.id) ?? new Set<number>();
      // Dedup: each /skeptic comment fires exactly once
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      processedCommentIds.set(session.id, seen);
      await triggerSkepticReaction(session, lastSkepticSha, correlationId);
      // Process at most one new /skeptic comment per poll cycle
      break;
    }
  } catch {
    // Non-fatal: skip this cycle
  }
}
