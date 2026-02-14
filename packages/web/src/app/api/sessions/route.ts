import { NextResponse } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, computeStats } from "@/lib/serialize";

/** GET /api/sessions — List all sessions with full state */
export async function GET() {
  try {
    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

    const dashboardSessions = coreSessions.map(sessionToDashboard);

    // Enrich sessions that have PRs with live SCM data (CI, reviews, mergeability)
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
      const project = config.projects[core.projectId];
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
