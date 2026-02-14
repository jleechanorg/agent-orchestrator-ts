import { type NextRequest, NextResponse } from "next/server";
import { getMockSession } from "@/lib/mock-data";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";

const MAX_MESSAGE_LENGTH = 10_000;

/** POST /api/sessions/:id/send — Send a message to a session */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  const session = getMockSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return NextResponse.json({ error: messageErr }, { status: 400 });
  }

  // Strip control characters to prevent injection when passed to shell-based runtimes
  const message = stripControlChars(String(body?.message ?? ""));

  // Re-validate after stripping — a control-char-only message becomes empty
  if (message.trim().length === 0) {
    return NextResponse.json(
      { error: "message must not be empty after sanitization" },
      { status: 400 },
    );
  }

  // TODO: wire to core SessionManager.send()
  return NextResponse.json({ ok: true, sessionId: id, message });
}
