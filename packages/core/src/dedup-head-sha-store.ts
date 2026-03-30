/**
 * bd-n039: Message-Content Hash Store
 *
 * Persists the last-sent message content hash per session. The hash is SHA256 of
 * the final message (with {{context}} resolved), providing true content-level dedup
 * even when the PR head SHA is unchanged but the context content has changed.
 *
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
 * In-memory message content hash dedup state.
 * Keyed by `${sessionId}:${reactionKey}` to isolate dedup per reaction type.
 * cursor[bot] Medium (bd-n039): reactionKey must be part of the dedup key —
 * when multiple reaction types (e.g. ci-failed + changes-requested) both send
 * to the same session, they must not collide on the same content hash.
 */
const messageHashStore = new Map<string, string>();

/** Composite key: projectId + sessionId + reactionKey for cross-project isolation. */
function dedupKey(projectId: string, sessionId: SessionId, reactionKey: string): string {
  return `${projectId}:${sessionId}:${reactionKey}`;
}

/** Extract sessionId from a composite key (format: projectId:sessionId:reactionKey). */
function extractSessionIdFromKey(compositeKey: string): SessionId {
  const firstSep = compositeKey.indexOf(":");
  const secondSep = compositeKey.indexOf(":", firstSep + 1);
  // Format: projectId:sessionId:reactionKey → sessionId is between first and second ':'
  return secondSep >= 0 ? compositeKey.slice(firstSep + 1, secondSep) : compositeKey;
}

/**
 * Hash a string using SHA256 and return the hex digest.
 * Used for message-content-level dedup to skip re-sending identical messages.
 */
export async function hashMessageContent(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Get the last-sent message content hash for a project+session+reaction.
 * Returns undefined if no hash has been recorded.
 * cursor[bot] Medium (bd-n039): keyed by projectId:sessionId:reactionKey to prevent
 * cross-project and cross-reaction hash collisions.
 */
export function getLastSentMessageHash(
  projectId: string,
  sessionId: SessionId,
  reactionKey: string,
): string | undefined {
  return messageHashStore.get(dedupKey(projectId, sessionId, reactionKey));
}

/**
 * Record the message content hash after a successful send-to-agent dispatch.
 * cursor[bot] Medium (bd-n039): keyed by projectId:sessionId:reactionKey.
 */
export function setLastSentMessageHash(
  projectId: string,
  sessionId: SessionId,
  reactionKey: string,
  hash: string,
): void {
  messageHashStore.set(dedupKey(projectId, sessionId, reactionKey), hash);
}

/**
 * Clear all message content hash entries for a session.
 * Used in tests to reset dedup state between test cases.
 */
export function clearAllMessageHashesForSession(sessionId: SessionId): void {
  for (const compositeKey of messageHashStore.keys()) {
    if (extractSessionIdFromKey(compositeKey) === sessionId) {
      messageHashStore.delete(compositeKey);
    }
  }
}

/**
 * Get the last-sent head SHA for a project+session+reaction.
 * Returns undefined if no SHA has been recorded.
 * bd-n039 fix: keyed by projectId:sessionId:reactionKey for cross-project isolation
 * and to match message hash dedup, preventing one reaction type from advancing
 * the SHA for another.
 */
export function getLastSentHeadSha(
  projectId: string,
  sessionId: SessionId,
  reactionKey: string,
): string | undefined {
  return headShaStore.get(dedupKey(projectId, sessionId, reactionKey));
}

/**
 * Record the PR head SHA after a successful send-to-agent dispatch.
 * bd-n039 fix: keyed by projectId:sessionId:reactionKey for cross-project isolation
 * and scoped SHA dedup per reaction.
 */
export function setLastSentHeadSha(
  projectId: string,
  sessionId: SessionId,
  reactionKey: string,
  sha: string,
): void {
  headShaStore.set(dedupKey(projectId, sessionId, reactionKey), sha);
}

/**
 * Clear all SHA dedup entries for a session.
 * Used in tests to reset dedup state between test cases.
 * bd-n039 fix: clears all composite-key entries for this session.
 */
export function clearLastSentHeadSha(sessionId: SessionId): void {
  for (const compositeKey of headShaStore.keys()) {
    if (extractSessionIdFromKey(compositeKey) === sessionId) {
      headShaStore.delete(compositeKey);
    }
  }
}

/**
 * Prune dedup entries for session IDs that are no longer active.
 * bd-n039 fix: keyed by projectId:sessionId:reactionKey — only deletes entries whose
 * projectId matches AND whose sessionId is not in liveSessionIds. This prevents one
 * lifecycle-manager instance from pruning another instance's entries (each LM only
 * passes its own projectId and live sessions).
 *
 * @param projectId Only prune entries belonging to this project.
 * @param liveSessionIds Set of session IDs currently managed by the caller.
 */
export function pruneStaleSessionIds(projectId: string, liveSessionIds: Set<SessionId>): void {
  for (const compositeKey of headShaStore.keys()) {
    const sep = compositeKey.indexOf(":");
    if (sep < 0) continue;
    const keyProjectId = compositeKey.slice(0, sep);
    if (keyProjectId !== projectId) continue; // only prune our project's entries
    if (!liveSessionIds.has(extractSessionIdFromKey(compositeKey))) {
      headShaStore.delete(compositeKey);
    }
  }
  for (const compositeKey of messageHashStore.keys()) {
    const sep = compositeKey.indexOf(":");
    if (sep < 0) continue;
    const keyProjectId = compositeKey.slice(0, sep);
    if (keyProjectId !== projectId) continue;
    if (!liveSessionIds.has(extractSessionIdFromKey(compositeKey))) {
      messageHashStore.delete(compositeKey);
    }
  }
}
