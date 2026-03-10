import {
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  GLOBAL_PAUSE_UNTIL_KEY,
  parsePauseUntil,
} from "@composio/ao-core";

export interface GlobalPauseState {
  pausedUntil: string;
  reason: string;
  sourceSessionId: string | null;
}

export function resolveGlobalPause(
  sessions: Array<{ id: string; metadata: Record<string, string> }>,
): GlobalPauseState | null {
  const orchestrator = sessions.find((session) => session.id.endsWith("-orchestrator"));
  const pausedUntilRaw = orchestrator?.metadata[GLOBAL_PAUSE_UNTIL_KEY];
  const parsed = parsePauseUntil(pausedUntilRaw);
  if (!parsed || parsed.getTime() <= Date.now()) return null;

  return {
    pausedUntil: parsed.toISOString(),
    reason: orchestrator?.metadata[GLOBAL_PAUSE_REASON_KEY] ?? "Model rate limit reached",
    sourceSessionId: orchestrator?.metadata[GLOBAL_PAUSE_SOURCE_KEY] ?? null,
  };
}
