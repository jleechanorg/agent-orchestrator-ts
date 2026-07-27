export const GLOBAL_PAUSE_UNTIL_KEY = "globalPauseUntil";
export const GLOBAL_PAUSE_REASON_KEY = "globalPauseReason";
export const GLOBAL_PAUSE_SOURCE_KEY = "globalPauseSource";
export const GLOBAL_PAUSE_CREATED_AT_KEY = "globalPauseCreatedAt";

export function parsePauseUntil(raw: string | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function formatPauseKeySuffix(agentName?: string, model?: string): string {
  if (agentName && model) {
    return `_${agentName}:${model}`;
  }
  if (agentName) {
    return `_${agentName}`;
  }
  return "";
}
