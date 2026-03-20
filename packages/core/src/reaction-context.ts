/**
 * Build context string for a reaction based on session/PR details.
 * Extracted from lifecycle-manager.ts for fork isolation.
 */

import type {
  Session,
  SCM,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";

export async function buildReactionContext(
  reactionKey: string,
  session: Session,
  projectId: string,
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<string> {
  const project = config.projects[projectId];
  if (!project || !session.pr) return "";

  const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
  if (!scm) return "";

  try {
    switch (reactionKey) {
      case "ci-failed": {
        const checks = await scm.getCIChecks(session.pr);
        const failing = checks.filter((c) => c.status === "failed");
        if (failing.length === 0) return "";
        const lines = failing.map((c) => {
          const urlPart = c.url ? ` (${c.url})` : "";
          return `- ${c.name}${urlPart}`;
        });
        return `Failing checks:\n${lines.join("\n")}`;
      }
      case "changes-requested": {
        const comments = await scm.getPendingComments(session.pr);
        if (comments.length === 0) return "";
        const lines = comments.slice(0, 5).map((c) => {
          const pathPart = c.path ? ` ${c.path}:${c.line ?? ""}` : "";
          return `-${pathPart} ${c.body.slice(0, 100)}${c.body.length > 100 ? "..." : ""}`;
        });
        const more = comments.length > 5 ? `\n... and ${comments.length - 5} more` : "";
        return `Unresolved review comments:\n${lines.join("\n")}${more}`;
      }
      case "merge-conflicts": {
        const merge = await scm.getMergeability(session.pr);
        if (merge.noConflicts) return "";
        return `Merge blockers:\n${merge.blockers.map((b) => `- ${b}`).join("\n")}`;
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
}
