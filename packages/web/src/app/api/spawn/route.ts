import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return NextResponse.json({ error: issueErr }, { status: 400 });
    }
  }

  // TODO: wire to core SessionManager.spawn()
  const mockSession = {
    id: `session-${Date.now()}`,
    projectId: body.projectId as string,
    issueId: (body.issueId as string) ?? null,
    status: "spawning",
    activity: "active",
    branch: null,
    summary: `Spawning session for ${(body.issueId as string) ?? body.projectId}`,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  };

  return NextResponse.json({ session: mockSession }, { status: 201 });
}
