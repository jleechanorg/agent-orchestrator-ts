import { type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  getSessionsDir,
  updateMetadata,
} from "@jleechanorg/ao-core";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { validateIdentifier } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

const DISPLAY_NAME_MAX_LENGTH = 80;

function stripControlChars(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1F\x7F]/g, "");
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const dashboardSession = sessionToDashboard(coreSession);

    // Enrich metadata (issue labels, agent summaries, issue titles)
    await enrichSessionsMetadata([coreSession], [dashboardSession], config, registry);

    // Enrich PR — serve cache immediately, refresh in background if stale
    if (coreSession.pr) {
      const project = resolveProject(coreSession, config.projects);
      const scm = getSCM(registry, project);
      if (scm) {
        const cached = await enrichSessionPR(dashboardSession, scm, coreSession.pr, {
          cacheOnly: true,
        });
        if (!cached) {
          // Nothing cached yet — block once to populate, then future calls use cache
          await enrichSessionPR(dashboardSession, scm, coreSession.pr);
        }
      }
    }

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: coreSession.projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(dashboardSession, { status: 200 }, correlationId);
  } catch (error) {
    const { id } = await params;
    const { config, sessionManager } = await getServices().catch(() => ({
      config: undefined,
      sessionManager: undefined,
    }));
    const session = sessionManager ? await sessionManager.get(id).catch(() => null) : null;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: session?.projectId,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    return jsonWithCorrelation({ error: "Internal server error" }, { status: 500 }, correlationId);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;

  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  let body: Record<string, unknown> | null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonWithCorrelation(
      { error: "Invalid JSON in request body" },
      { status: 400 },
      correlationId,
    );
  }
  if (!body || typeof body !== "object") {
    return jsonWithCorrelation({ error: "Invalid request body" }, { status: 400 }, correlationId);
  }

  if (!Object.prototype.hasOwnProperty.call(body, "displayName")) {
    return jsonWithCorrelation(
      { error: "displayName is required" },
      { status: 400 },
      correlationId,
    );
  }
  const raw = body["displayName"];
  if (raw !== null && typeof raw !== "string") {
    return jsonWithCorrelation(
      { error: "displayName must be a string or null" },
      { status: 400 },
      correlationId,
    );
  }

  const cleaned =
    raw === null
      ? ""
      : stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX_LENGTH);

  try {
    const { config, sessionManager } = await getServices();
    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const project = config.projects[coreSession.projectId];
    const sessionsDir = getSessionsDir(config.configPath ?? "", project?.path ?? coreSession.projectId);
    updateMetadata(sessionsDir, id, {
      displayName: cleaned,
      displayNameUserSet: cleaned === "" ? "" : "true",
    });

    const updated = await sessionManager.get(id);
    const dashboardSession = updated
      ? sessionToDashboard(updated)
      : sessionToDashboard(coreSession);

    recordApiObservation({
      config,
      method: "PATCH",
      path: "/api/sessions/[id]",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: coreSession.projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(dashboardSession, { status: 200 }, correlationId);
  } catch (error) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "PATCH",
        path: "/api/sessions/[id]",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    return jsonWithCorrelation({ error: "Internal server error" }, { status: 500 }, correlationId);
  }
}
