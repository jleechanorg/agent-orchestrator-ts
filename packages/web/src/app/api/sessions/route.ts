import type { Session, ProjectConfig } from "@agent-orchestrator/core";
import { NextResponse } from "next/server";
import { getServices, getSCM, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, enrichSessionIssue, computeStats } from "@/lib/serialize";

/** Resolve which project a session belongs to. */
function resolveProject(
  core: Session,
  projects: Record<string, ProjectConfig>,
): ProjectConfig | undefined {
  // Try explicit projectId first
  const direct = projects[core.projectId];
  if (direct) return direct;

  // Match by session prefix
  const entry = Object.entries(projects).find(([, p]) =>
    core.id.startsWith(p.sessionPrefix),
  );
  if (entry) return entry[1];

  // Fall back to first project
  const firstKey = Object.keys(projects)[0];
  return firstKey ? projects[firstKey] : undefined;
}

/** GET /api/sessions — List all sessions with full state */
export async function GET() {
  try {
    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

    // Filter out special orchestrator session - it's not a worker session
    const workerSessions = coreSessions.filter((s) => s.id !== "orchestrator");
    const dashboardSessions = workerSessions.map(sessionToDashboard);

    // Enrich issue labels using tracker plugin (synchronous)
    workerSessions.forEach((core, i) => {
      if (!dashboardSessions[i].issueUrl) return;
      const project = resolveProject(core, config.projects);
      const tracker = getTracker(registry, project);
      if (!tracker || !project) return;
      enrichSessionIssue(dashboardSessions[i], tracker, project);
    });

    // Enrich sessions that have PRs with live SCM data (CI, reviews, mergeability)
    const enrichPromises = workerSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(dashboardSessions[i], scm, core.pr);
    });
    await Promise.allSettled(enrichPromises);

    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
