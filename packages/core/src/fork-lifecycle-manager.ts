/**
 * Fork-specific lifecycle extensions for rate-limit detection and project-level pausing.
 *
 * Extracted from lifecycle-manager.ts to keep the upstream core diff minimal.
 * See CLAUDE.md: "New features go in new files; never add fork logic inline to upstream files."
 */

import { updateMetadata, readMetadataRaw } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  GLOBAL_PAUSE_CREATED_AT_KEY,
  parsePauseUntil,
} from "./global-pause.js";
import type { Session, SessionManager, Runtime, ProjectConfig as _ProjectConfig } from "./types.js";

/**
 * Parse a terminal output string looking for Claude Code / OpenCode rate-limit messages.
 * Returns the Date when the limit will reset, or null if no rate limit is detected.
 */
export function parseRateLimitReset(output: string): Date | null {
  if (!/usage\s+limit\s+reached/i.test(output)) return null;

  // Scan ALL "limit will reset at YYYY-MM-DD HH:MM" occurrences and pick the
  // latest future one. A single output may contain multiple banners (e.g. one
  // stale line from a previous scroll-back and one fresh line); returning the
  // first match could return a timestamp already in the past.
  const resetRegex =
    /limit\s+will\s+reset\s+at\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{1,2})/gi;
  let latestReset: Date | null = null;
  let match: RegExpExecArray | null;
  while ((match = resetRegex.exec(output)) !== null) {
    const [year, month, day] = match[1].split("-").map((part) => Number.parseInt(part, 10));
    const hour = Number.parseInt(match[2], 10);
    const minute = Number.parseInt(match[3], 10);
    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      Number.isFinite(hour) &&
      Number.isFinite(minute)
    ) {
      // Use local Date (not UTC) so the reset timestamp matches the user's system timezone,
      // which is the timezone used in agent terminal output.
      const parsed = new Date(year, month - 1, day, hour, minute, 0);
      if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
        if (!latestReset || parsed.getTime() > latestReset.getTime()) {
          latestReset = parsed;
        }
      }
    }
  }
  if (latestReset) return latestReset;

  // Fall back to relative duration only when no future explicit reset timestamp was found.
  const durationMatch = output.match(
    /usage\s+limit\s+reached\s+for\s+(\d+)\s*(hour|hours|hr|h|minute|minutes|min|m)/i,
  );
  if (!durationMatch) return null;
  const value = Number.parseInt(durationMatch[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = durationMatch[2].toLowerCase();
  const millis = unit.startsWith("h") ? value * 3_600_000 : value * 60_000;
  return new Date(Date.now() + millis);
}

/**
 * Persist a project-level rate-limit pause onto the orchestrator session metadata.
 * Only updates if the orchestrator session already exists (avoids phantom sessions).
 */
export function setProjectPause(
  configPath: string,
  project: _ProjectConfig,
  sourceSessionId: string,
  until: Date,
): void {
  const sessionsDir = getSessionsDir(configPath, project.path);
  const orchestratorId = `${project.sessionPrefix}-orchestrator`;
  // Guard: only update if orchestrator session already exists to avoid creating phantom sessions
  if (!readMetadataRaw(sessionsDir, orchestratorId)) return;
  const message = `Model rate limit detected from ${sourceSessionId}`;
  updateMetadata(sessionsDir, orchestratorId, {
    [GLOBAL_PAUSE_UNTIL_KEY]: until.toISOString(),
    [GLOBAL_PAUSE_REASON_KEY]: message,
    [GLOBAL_PAUSE_SOURCE_KEY]: sourceSessionId,
    [GLOBAL_PAUSE_CREATED_AT_KEY]: new Date().toISOString(),
  });
}

/**
 * Clear an active rate-limit pause from the orchestrator session metadata.
 * Preserves UNTIL, SOURCE, and CREATED_AT provenance keys so the re-pause loop
 * guard in detectAndApplyRateLimitPause can still enforce the grace window after
 * the pause expires (it reads the expired UNTIL to compute the grace period).
 * Only the human-readable REASON is cleared to signal the pause is no longer active.
 */
export function clearProjectPause(configPath: string, project: _ProjectConfig): void {
  const sessionsDir = getSessionsDir(configPath, project.path);
  const orchestratorId = `${project.sessionPrefix}-orchestrator`;
  // Guard: only update if orchestrator session already exists to avoid creating phantom sessions
  if (!readMetadataRaw(sessionsDir, orchestratorId)) return;
  updateMetadata(sessionsDir, orchestratorId, {
    [GLOBAL_PAUSE_REASON_KEY]: "",
    // Intentionally preserve GLOBAL_PAUSE_UNTIL_KEY so detectAndApplyRateLimitPause
    // can read the expired timestamp as existingUntil for its grace-window check.
    // Intentionally preserve GLOBAL_PAUSE_SOURCE_KEY and GLOBAL_PAUSE_CREATED_AT_KEY
    // for the same reason.
  });
}

/**
 * Detect a rate-limit message in the agent's terminal output and apply a project pause.
 * Guards against re-pause loops from stale duration-based rate-limit messages.
 */
export async function detectAndApplyRateLimitPause(
  configPath: string,
  session: Session,
  project: _ProjectConfig,
  runtime: Runtime,
  sessionManager: SessionManager,
): Promise<void> {
  if (!session.runtimeHandle) return;
  try {
    const output = await runtime.getOutput(session.runtimeHandle, 60);
    if (!output) return;
    const resetAt = parseRateLimitReset(output);
    if (!resetAt) return;
    if (resetAt.getTime() <= Date.now()) return;

    // Check if there's already an active pause from this session
    // to prevent infinite re-pause loops with duration-based rate limits
    const orchestratorId = `${project.sessionPrefix}-orchestrator`;
    const orchestratorSession = await sessionManager.get(orchestratorId);
    if (orchestratorSession) {
      const existingUntil = parsePauseUntil(orchestratorSession.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
      const existingSource = orchestratorSession.metadata[GLOBAL_PAUSE_SOURCE_KEY];
      const existingCreatedAt = orchestratorSession.metadata[GLOBAL_PAUSE_CREATED_AT_KEY];

      // If there's an active pause from the same session, don't override
      // This prevents extending duration-based pauses on every poll cycle
      if (
        existingUntil &&
        existingUntil.getTime() > Date.now() &&
        existingSource === session.id
      ) {
        return;
      }

      // If there's a recently-expired duration-based pause, enforce a project-wide grace window.
      // Duration-based messages compute resetAt as Date.now() + duration, so they always
      // produce a future timestamp even if the message is stale. Any session can trigger a
      // re-pause from a stale banner; making the grace window project-wide (not scoped to
      // existingSource === session.id) prevents any worker from re-applying before the
      // grace period ends.
      // The presence of existingCreatedAt identifies a duration-based (relative) pause.
      if (existingUntil && existingUntil.getTime() <= Date.now() && existingCreatedAt) {
        const createdAt = new Date(existingCreatedAt);
        // Guard against invalid date strings — treat as "in grace period" to prevent re-pause loops
        if (Number.isNaN(createdAt.getTime())) return;
        const pauseDuration = existingUntil.getTime() - createdAt.getTime();
        // Only re-apply if we're well past the original pause window (2x duration as grace period)
        const gracePeriod = Math.max(pauseDuration * 2, 60_000); // At least 1 minute
        if (Date.now() - existingUntil.getTime() < gracePeriod) {
          return;
        }
      }

      // If there's a longer pause already active from another session, keep it
      if (
        existingUntil &&
        existingUntil.getTime() > Date.now() &&
        existingUntil.getTime() >= resetAt.getTime()
      ) {
        return;
      }
    }

    setProjectPause(configPath, project, session.id, resetAt);
  } catch {
    return;
  }
}
