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
  failedCommentIds: Map<string, Set<number>>,
  lastSkepticSha: Map<string, string>,
  correlationId: string,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  triggerSkepticReaction: TriggerFn,
): Promise<void> {
  if (!session.pr) return;
  const project = config.projects?.[session.projectId];
  if (!project) return;
  const scmPluginName = project.scm?.plugin || "github";
  const scm = registry.get<SCM>("scm", scmPluginName);
  if (!scm?.listPRComments) return;

  try {
    const comments = await scm.listPRComments(session.pr);
    for (const c of comments) {
      // Skip bot authors
      if (c.user.login.endsWith("[bot]")) continue;
      // Consume the structured trigger signal set by the SCM plugin — app
      // code MUST NOT re-parse the comment body. The SCM provider is the
      // single source of truth for "is this a /skeptic trigger?".
      if (c.isSkepticTrigger !== true) continue;
      const seen = processedCommentIds.get(session.id) ?? new Set<number>();
      // Skip permanently failed comments to avoid infinite polling
      const failed = failedCommentIds.get(session.id) ?? new Set<number>();
      if (seen.has(c.id) || failed.has(c.id)) continue;
      const success = await triggerSkepticReaction(session, lastSkepticSha, correlationId);
      if (success) {
        seen.add(c.id);
        processedCommentIds.set(session.id, seen);
      } else {
        // Permanent failure — record so we skip on every subsequent poll
        failed.add(c.id);
        failedCommentIds.set(session.id, failed);
      }
      // Process at most one new /skeptic comment per poll cycle
      break;
    }
  } catch {
    // Non-fatal: skip this cycle
  }
}
