/**
 * Reaction validation — validates that reaction definitions have required fields.
 *
 * Companion module: config.ts is upstream code; reaction validation is a fork
 * feature so it lives here to avoid merge conflicts.
 */

import type { OrchestratorConfig } from "./types.js";

export interface ReactionValidationIssue {
  reactionKey: string;
  scope: "global" | "project";
  projectId?: string;
  message: string;
}

export function validateReactionDefinitions(config: OrchestratorConfig): ReactionValidationIssue[] {
  const issues: ReactionValidationIssue[] = [];

  for (const [key, reaction] of Object.entries(config.reactions ?? {})) {
    if (!reaction) continue;

    if (!reaction.action) {
      issues.push({
        reactionKey: key,
        scope: "global",
        message: `Global reaction "${key}" is missing required field "action".`,
      });
    }

    if (reaction.auto === undefined) {
      issues.push({
        reactionKey: key,
        scope: "global",
        message: `Global reaction "${key}" is missing required field "auto".`,
      });
    }
  }

  for (const [projectId, project] of Object.entries(config.projects ?? {})) {
    if (!project.reactions) continue;

    for (const [key, reaction] of Object.entries(project.reactions)) {
      if (!reaction) continue;

      if (!reaction.action) {
        issues.push({
          reactionKey: key,
          scope: "project",
          projectId,
          message: `Project "${projectId}" reaction "${key}" is missing required field "action".`,
        });
      }
    }
  }

  return issues;
}
