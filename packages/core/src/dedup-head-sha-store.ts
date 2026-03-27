/**
 * bd-1178: Dedup Head SHA Store
 *
 * Persists the last-sent PR head SHA per session, independent of ReactionTracker.
 * ReactionTracker is cleared by clearReactionTracker() on status transitions and
 * lives in an in-memory Map that is lost on process restart. This store provides
 * durable SHA dedup state within the same process lifecycle, preventing redundant
 * sends after lifecycle-manager restarts or after status transitions that clear
 * the tracker.
 *
 * In-memory Map (not file-backed) — survives within a single lifecycle-manager
 * process but is naturally cleared on restart. File/DB-backed persistence can be
 * added later if cross-process dedup is needed.
 */

type SessionId = string;

/** In-memory SHA dedup state, keyed by sessionId. */
const headShaStore = new Map<SessionId, string>();

/**
 * Get the last-sent head SHA for a session.
 * Returns undefined if no SHA has been recorded for this session.
 */
export function getLastSentHeadSha(sessionId: SessionId): string | undefined {
  return headShaStore.get(sessionId);
}

/**
 * Record the PR head SHA after a successful send-to-agent dispatch.
 * The SHA is stored per-session and survives ReactionTracker clearing.
 */
export function setLastSentHeadSha(sessionId: SessionId, sha: string): void {
  headShaStore.set(sessionId, sha);
}

/**
 * Clear the SHA record for a session. Call this when the session is closed/merged/killed.
 */
export function clearLastSentHeadSha(sessionId: SessionId): void {
  headShaStore.delete(sessionId);
}

/**
 * Prune SHA dedup entries for session IDs that are no longer active.
 * CR 3002468214 / cursor#3002468214: only deletes entries whose sessionId is NOT in
 * liveSessionIds, preventing cross-project pollution when multiple lifecycle-manager
 * instances share the same process (each LM passes only its own active session set).
 *
 * @param liveSessionIds Set of session IDs currently managed by the caller.
 */
export function pruneStaleSessionIds(liveSessionIds: Set<SessionId>): void {
  for (const trackedSessionId of headShaStore.keys()) {
    if (!liveSessionIds.has(trackedSessionId)) {
      headShaStore.delete(trackedSessionId);
    }
  }
}
