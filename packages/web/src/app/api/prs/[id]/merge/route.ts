import { type NextRequest, NextResponse } from "next/server";
import { mockSessions } from "@/lib/mock-data";

/** POST /api/prs/:id/merge — Merge a PR */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "Invalid PR number" }, { status: 400 });
  }
  const prNumber = Number(id);

  const session = mockSessions.find((s) => s.pr?.number === prNumber);
  if (!session?.pr) {
    return NextResponse.json({ error: "PR not found" }, { status: 404 });
  }

  if (session.pr.state !== "open") {
    return NextResponse.json({ error: `PR is ${session.pr.state}, not open` }, { status: 409 });
  }

  if (session.pr.isDraft) {
    return NextResponse.json({ error: "Cannot merge a draft PR" }, { status: 422 });
  }

  if (!session.pr.mergeability.mergeable) {
    return NextResponse.json(
      { error: "PR is not mergeable", blockers: session.pr.mergeability.blockers },
      { status: 422 },
    );
  }

  // TODO: wire to core SCM.mergePR()
  return NextResponse.json({ ok: true, prNumber, method: "squash" });
}
