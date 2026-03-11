import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { getPrimaryProjectId, getProjectName, getAllProjects } from "@/lib/project-name";
import { filterWorkerSessions, findOrchestratorSessionId } from "@/lib/project-utils";
import { resolveGlobalPause, type GlobalPauseState } from "@/lib/global-pause";

function getSelectedProjectName(projectFilter: string | undefined): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selectedProject = projects.find((project) => project.id === projectFilter);
    if (selectedProject) return selectedProject.name;
  }
  return getProjectName();
}

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = searchParams.project ?? getPrimaryProjectId();
  const projectName = getSelectedProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  let sessions: DashboardSession[] = [];
  let orchestratorId: string | null;
  let globalPause: GlobalPauseState | null;
  // Allow ?project=all to show all sessions (for multi-project setups)
  const projectFilter = searchParams.project ?? getPrimaryProjectId();

  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    orchestratorId = findOrchestratorSessionId(allSessions, projectFilter, config.projects);

    globalPause = resolveGlobalPause(allSessions);

    const coreSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);

    sessions = coreSessions.map(sessionToDashboard);

    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([
      enrichSessionsMetadata(coreSessions, sessions, config, registry),
      metaTimeout,
    ]);

    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();

      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      if (cached) {
        if (sessions[i].pr) {
          sessions[i].pr.state = cached.state;
          sessions[i].pr.title = cached.title;
          sessions[i].pr.additions = cached.additions;
          sessions[i].pr.deletions = cached.deletions;
          sessions[i].pr.ciStatus = cached.ciStatus as "none" | "pending" | "passing" | "failing";
          sessions[i].pr.reviewDecision = cached.reviewDecision as
            | "none"
            | "pending"
            | "approved"
            | "changes_requested";
          sessions[i].pr.ciChecks = cached.ciChecks.map((c) => ({
            name: c.name,
            status: c.status as "pending" | "running" | "passed" | "failed" | "skipped",
            url: c.url,
          }));
          sessions[i].pr.mergeability = cached.mergeability;
          sessions[i].pr.unresolvedThreads = cached.unresolvedThreads;
          sessions[i].pr.unresolvedComments = cached.unresolvedComments;
        }

        if (
          terminalStatuses.has(core.status) ||
          cached.state === "merged" ||
          cached.state === "closed"
        ) {
          return Promise.resolve();
        }
      }

      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(sessions[i], scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
  } catch {
    sessions = [];
    orchestratorId = null;
    globalPause = null;
  }

  const projectName = getSelectedProjectName(projectFilter);
  const projects = getAllProjects();
  const selectedProjectId = projectFilter === "all" ? undefined : projectFilter;

  return (
    <Dashboard
      initialSessions={sessions}
      orchestratorId={orchestratorId}
      projectId={selectedProjectId}
      projectName={projectName}
      projects={projects}
      initialGlobalPause={globalPause}
    />
  );
}
