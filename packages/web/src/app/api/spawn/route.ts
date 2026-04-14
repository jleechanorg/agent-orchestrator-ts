import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return jsonWithCorrelation({ error: projectErr }, { status: 400 }, correlationId);
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return jsonWithCorrelation({ error: issueErr }, { status: 400 }, correlationId);
    }
  }

  try {
    const { config, sessionManager } = await getServices();

    // Validate and sanitize prompt: must be string (not object/array/number), stripped of newlines, capped at 4096 chars
    if (body.prompt !== undefined && typeof body.prompt !== "string") {
      return jsonWithCorrelation(
        { error: "prompt must be a string" },
        { status: 400 },
        correlationId,
      );
    }
    const rawPrompt = body.prompt as string | undefined;
    let prompt = rawPrompt ? rawPrompt.replace(/[\r\n]/g, " ").trim() : undefined;
    if (prompt && prompt.length > 4096) {
      return jsonWithCorrelation(
        { error: "Prompt must be at most 4096 characters" },
        { status: 400 },
        correlationId,
      );
    }

    const session = await sessionManager.spawn({
      projectId: body.projectId as string,
      issueId: (body.issueId as string) ?? undefined,
      prompt: prompt || undefined,
    });

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/spawn",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 201,
      projectId: session.projectId,
      sessionId: session.id,
      data: { issueId: session.issueId },
    });

    return jsonWithCorrelation(
      { session: sessionToDashboard(session) },
      { status: 201 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        reason: err instanceof Error ? err.message : "Failed to spawn session",
        data: { issueId: body.issueId },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
      correlationId,
    );
  }
}
