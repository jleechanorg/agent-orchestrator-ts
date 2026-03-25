/**
 * Shared test helpers for session-reaper tests.
 * Imported by session-reaper.test.ts and session-reaper-edge-cases.test.ts.
 */
import { vi } from "vitest";
import { DEFAULT_REAPER_CONFIG, type ReaperConfig, type ReaperDeps } from "../session-reaper.js";
import type { Session, SessionManager, SessionId } from "../types.js";

export const BASE_NOW = new Date("2025-01-01T12:00:00Z");
export const TWO_HOURS_MS = 7_200_000;
export const FOUR_HOURS_MS = 14_400_000;

export function makeSession(id: SessionId, overrides?: Partial<Session>): Session {
  return {
    id,
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: `branch-${id}`,
    issueId: null,
    pr: null,
    workspacePath: `/tmp/${id}`,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(BASE_NOW.getTime() - FOUR_HOURS_MS - 1000),
    lastActivityAt: new Date(BASE_NOW.getTime() - TWO_HOURS_MS - 1000),
    metadata: {},
    ...overrides,
  };
}

export function makeSessionManager(sessions: Session[]): SessionManager {
  const sm: SessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue(sessions),
    get: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  };
  return sm;
}

export function makeConfig(overrides?: Partial<ReaperConfig>): ReaperConfig {
  return {
    orphanedThresholdMs: TWO_HOURS_MS,
    noPrThresholdMs: FOUR_HOURS_MS,
    maxKillsPerRun: DEFAULT_REAPER_CONFIG.maxKillsPerRun, // track runtime default
    ...overrides,
  };
}

export function makeDeps(sm: SessionManager): ReaperDeps {
  return {
    sessionManager: sm,
    now: BASE_NOW,
  };
}
