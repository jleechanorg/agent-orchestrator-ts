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

import { checkMergeGate } from "./merge-gate.js";
import { buildActionPlan, formatActionPlan } from "./action-plan.js";

/**
 * Extract structured sections from a skeptic FAIL comment body.
 * The skeptic agent posts comments with ## Background, ## Current Problem,
 * and ## Recommended Solution sections. Returns the extracted content.
 */
function extractSkepticSections(body: string): string {
  const sections: string[] = [];

  const background = extractSection(body, "Background");
  if (background) sections.push(`## Background\n${background}`);

  const problem = extractSection(body, "Current Problem");
  if (problem) sections.push(`## Current Problem\n${problem}`);

  const solution = extractSection(body, "Recommended Solution");
  if (solution) sections.push(`## Recommended Solution\n${solution}`);

  // Fall back to raw body if no sections found
  if (sections.length === 0) {
    return body.slice(0, 2000);
  }

  return sections.join("\n\n");
}

/** Extract the content between a ## Section header and the next ## header or end of string. */
function extractSection(body: string, sectionName: string): string | null {
  // Match ## Section Name\n or ## Section Name\r\n, then capture everything up to the next ## or end
  const pattern = new RegExp(
    `##\\s+${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n([\\s\\S]*?)(?=##\\s+[\\w ]|\\Z)`,
    "i",
  );
  const match = body.match(pattern);
  if (!match) return null;
  const content = match[1].trim();
  return content.length > 0 ? content : null;
}

/**
 * Append a prioritized gate-closure action plan to reaction context.
 * Runs checkMergeGate to discover failing gates, formats the result as
 * worker-readable text, and returns it for injection into the reaction message.
 */
async function appendActionPlan(
  scm: SCM,
  pr: Session["pr"],
  projectId: string,
  config: OrchestratorConfig,
): Promise<string> {
  if (!pr) return "";
  const project = config.projects[projectId];
  const mergeGateConfig = project?.mergeGate ?? { enabled: true };
  try {
    const gateResult = await checkMergeGate(
      pr,
      mergeGateConfig,
      scm,
    );
    const plan = buildActionPlan(gateResult);
    return formatActionPlan(plan);
  } catch {
    return "";
  }
}

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
        // Always compute the action plan even when comments.length === 0,
        // because other gates (CI, conflicts) may still be failing.
        const lines = comments.slice(0, 5).map((c) => {
          const pathPart = c.path ? ` ${c.path}:${c.line ?? ""}` : "";
          return `-${pathPart} ${c.body.slice(0, 100)}${c.body.length > 100 ? "..." : ""}`;
        });
        const more = comments.length > 5 ? `\n... and ${comments.length - 5} more` : "";
        const commentText = lines.length > 0
          ? `Unresolved review comments:\n${lines.join("\n")}${more}`
          : "";
        const actionPlanText = await appendActionPlan(scm, session.pr, projectId, config);
        const parts = [commentText, actionPlanText].filter(Boolean);
        return parts.join("\n\n");
      }
      case "merge-conflicts": {
        const merge = await scm.getMergeability(session.pr);
        if (merge.noConflicts) return "";
        return `Merge blockers:\n${merge.blockers.map((b) => `- ${b}`).join("\n")}`;
      }
      case "agent-needs-input":
      case "agent-stuck": {
        const summary = await buildPRStatusSummary(scm, session);
        const actionPlanText = await appendActionPlan(scm, session.pr, projectId, config);
        return actionPlanText ? `${summary}\n\n${actionPlanText}` : summary;
      }
      case "skeptic-advice": {
        // Fetch skeptic agent comments and extract structured sections from the
        // most recent FAIL verdict for delivery to the worker agent.
        if (!scm.getSkepticComments) return "";
        const comments = await scm.getSkepticComments(session.pr!);
        // Find the latest FAIL verdict comment
        let latestFail: { id: number; body: string } | null = null;
        for (const c of comments) {
          if (/VERDICT:\s*FAIL/i.test(c.body) && c.id > (latestFail?.id ?? -1)) {
            latestFail = { id: c.id, body: c.body };
          }
        }
        if (!latestFail) return "";
        return extractSkepticSections(latestFail.body);
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
}

/**
 * Build a comprehensive PR status summary for idle/stuck agents.
 * Includes CI status, pending comments, and commands to investigate.
 */
async function buildPRStatusSummary(scm: SCM, session: Session): Promise<string> {
  const pr = session.pr!;
  const parts: string[] = [`PR #${pr.number} (${pr.owner}/${pr.repo}) status:`];

  // CI status
  const checks = await scm.getCIChecks(pr);
  const failing = checks.filter((c) => c.status === "failed");
  if (failing.length > 0) {
    const failNames = failing.map((c) => c.name).join(", ");
    parts.push(`CI: ${failing.length} failing (${failNames})`);
  } else {
    parts.push(`CI: all passing`);
  }

  // Pending review comments
  const comments = await scm.getPendingComments(pr);
  if (comments.length > 0) {
    parts.push(`Reviews: ${comments.length} unresolved comment${comments.length > 1 ? "s" : ""}`);
    // Show first few comment summaries
    const previews = comments.slice(0, 3).map((c) => {
      const loc = c.path ? `${c.path}:${c.line ?? ""}` : "";
      const body = c.body.slice(0, 80) + (c.body.length > 80 ? "..." : "");
      return loc ? `  - ${loc}: ${body}` : `  - ${body}`;
    });
    parts.push(...previews);
  } else {
    parts.push(`Reviews: no unresolved comments`);
  }

  // Actionable command
  parts.push(`\nTo read feedback: gh api repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`);

  return parts.join("\n");
}
