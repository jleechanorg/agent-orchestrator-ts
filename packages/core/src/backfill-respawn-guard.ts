/**
 * Backfill respawn guard — caps lifecycle backfill respawns per PR and escalates
 * to the operator (Slack via notificationRouting) after the cap is exceeded.
 *
 * @module backfill-respawn-guard
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMetadataRaw, updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  parsePauseUntil,
} from "./global-pause.js";
import { parseKeyValueContent } from "./key-value.js";
import { parsePrFromUrl } from "./utils/pr.js";
import type { ProjectConfig } from "./types.js";

/** Max backfill respawns per open PR before requiring human intervention. */
export const BACKFILL_MAX_RESPAWNS_PER_PR = 6;

const BACKFILL_RESPAWN_NOTIFIED_PREFIX = "backfillRespawnNotified_";

export function getOrchestratorSessionId(project: ProjectConfig): string {
  return `${project.sessionPrefix}-orchestrator`;
}

export function backfillRespawnNotifiedKey(prNumber: number): string {
  return `${BACKFILL_RESPAWN_NOTIFIED_PREFIX}${prNumber}`;
}

export interface ProjectPauseState {
  until: Date;
  reason: string;
}

/**
 * Read an active project-level model pause from orchestrator metadata.
 * Returns null when no pause is active or orchestrator metadata is missing.
 */
export function readProjectPause(
  configPath: string,
  project: ProjectConfig,
  nowMs = Date.now(),
): ProjectPauseState | null {
  const sessionsDir = getSessionsDir(configPath, project.path);
  const raw = readMetadataRaw(sessionsDir, getOrchestratorSessionId(project));
  if (!raw) return null;

  const until = parsePauseUntil(raw[GLOBAL_PAUSE_UNTIL_KEY]);
  if (!until || until.getTime() <= nowMs) return null;

  return {
    until,
    reason: raw[GLOBAL_PAUSE_REASON_KEY] ?? "Model rate limit reached",
  };
}

/**
 * Count archived/killed sessions associated with a PR.
 * Each archive entry represents one prior backfill respawn cycle.
 */
export function countArchivedSessionsForPr(sessionsDir: string, prNumber: number): number {
  const archiveDir = join(sessionsDir, "archive");
  if (!existsSync(archiveDir)) return 0;

  let count = 0;
  for (const file of readdirSync(archiveDir)) {
    const archivePath = join(archiveDir, file);
    try {
      const raw = parseKeyValueContent(readFileSync(archivePath, "utf-8"));
      const prUrl = raw["pr"];
      if (!prUrl) continue;
      const parsed = parsePrFromUrl(prUrl);
      if (parsed?.number === prNumber) count++;
    } catch {
      // Best-effort scan — skip unreadable archive entries.
    }
  }
  return count;
}

/** PR numbers that have reached the backfill respawn cap. */
export function getPrNumbersAtRespawnCap(
  sessionsDir: string,
  maxRespawns = BACKFILL_MAX_RESPAWNS_PER_PR,
): Map<number, number> {
  const archiveDir = join(sessionsDir, "archive");
  const counts = new Map<number, number>();
  if (!existsSync(archiveDir)) return counts;

  for (const file of readdirSync(archiveDir)) {
    const archivePath = join(archiveDir, file);
    try {
      const raw = parseKeyValueContent(readFileSync(archivePath, "utf-8"));
      const prUrl = raw["pr"];
      if (!prUrl) continue;
      const parsed = parsePrFromUrl(prUrl);
      if (!parsed || !Number.isFinite(parsed.number)) continue;
      counts.set(parsed.number, (counts.get(parsed.number) ?? 0) + 1);
    } catch {
      // Best-effort scan — skip unreadable archive entries.
    }
  }

  for (const [prNumber, count] of [...counts.entries()]) {
    if (count < maxRespawns) counts.delete(prNumber);
  }
  return counts;
}

export function isPrRespawnCapNotified(
  configPath: string,
  project: ProjectConfig,
  prNumber: number,
): boolean {
  const sessionsDir = getSessionsDir(configPath, project.path);
  const raw = readMetadataRaw(sessionsDir, getOrchestratorSessionId(project));
  return raw?.[backfillRespawnNotifiedKey(prNumber)] === "true";
}

export function markPrRespawnCapNotified(
  configPath: string,
  project: ProjectConfig,
  prNumber: number,
): void {
  const sessionsDir = getSessionsDir(configPath, project.path);
  const orchestratorId = getOrchestratorSessionId(project);
  if (!readMetadataRaw(sessionsDir, orchestratorId)) return;
  updateMetadata(sessionsDir, orchestratorId, {
    [backfillRespawnNotifiedKey(prNumber)]: "true",
  });
}

/** Clear cap-notified flag when PR is no longer in respawn-cap state (operator recovery). */
export function clearPrRespawnCapNotified(
  configPath: string,
  project: ProjectConfig,
  prNumber: number,
): void {
  const sessionsDir = getSessionsDir(configPath, project.path);
  const orchestratorId = getOrchestratorSessionId(project);
  if (!readMetadataRaw(sessionsDir, orchestratorId)) return;
  updateMetadata(sessionsDir, orchestratorId, {
    [backfillRespawnNotifiedKey(prNumber)]: "",
  });
}
