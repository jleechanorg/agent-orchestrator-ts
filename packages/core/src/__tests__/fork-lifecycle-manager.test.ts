import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  parseRateLimitReset,
  setProjectPause,
  clearProjectPause,
  detectAndApplyRateLimitPause,
} from "../fork-lifecycle-manager.js";
import { readMetadataRaw } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  GLOBAL_PAUSE_CREATED_AT_KEY,
} from "../global-pause.js";
import type { ProjectConfig, Session, SessionManager, Runtime } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeConfigPath(): string {
  return join(tmpDir, "agent-orchestrator.yaml");
}

function makeProject(sessionPrefix = "app"): ProjectConfig {
  return {
    name: "app",
    path: tmpDir,
    sessionPrefix,
    runtime: "opencode",
    agent: "claude",
    workspace: "git",
    scm: "github",
    notifiers: [],
    agentRules: [],
    reactions: {},
    metadata: {},
  } as unknown as ProjectConfig;
}

/** Write a minimal metadata file so readMetadataRaw returns non-null (satisfies the guard). */
function writeOrchestratorSeed(sessionsDir: string, orchestratorId: string): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, orchestratorId),
    "status=active\nbranch=main\nworktree=/tmp/x\n",
    "utf-8",
  );
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: tmpDir,
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// parseRateLimitReset
// ---------------------------------------------------------------------------

describe("parseRateLimitReset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when output contains no rate-limit message", () => {
    expect(parseRateLimitReset("All good, no errors here")).toBeNull();
    expect(parseRateLimitReset("")).toBeNull();
  });

  it("returns null when output says 'usage limit reached' but no reset time or duration", () => {
    expect(parseRateLimitReset("usage limit reached")).toBeNull();
  });

  it("parses an explicit 'limit will reset at YYYY-MM-DD HH:MM' timestamp in the future", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const output = "usage limit reached\nlimit will reset at 2026-06-01 10:00";
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(false);
    expect(result?.resetAt.getFullYear()).toBe(2026);
    expect(result?.resetAt.getMonth()).toBe(5); // June = month index 5
    expect(result?.resetAt.getDate()).toBe(1);
    expect(result?.resetAt.getHours()).toBe(10);
    expect(result?.resetAt.getMinutes()).toBe(0);
  });

  it("ignores explicit reset timestamps already in the past", () => {
    vi.setSystemTime(new Date("2026-06-01T12:00:00"));
    const output = "usage limit reached\nlimit will reset at 2026-06-01 10:00";
    expect(parseRateLimitReset(output)).toBeNull();
  });

  it("falls back to duration parsing when explicit reset is in the past", () => {
    vi.setSystemTime(new Date("2026-06-01T12:00:00"));
    const output =
      "usage limit reached\nlimit will reset at 2026-06-01 10:00\nusage limit reached for 2 hours";
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(true);
    // Duration-based: now + 2h
    const expected = new Date("2026-06-01T14:00:00").getTime();
    expect(result?.resetAt.getTime()).toBeCloseTo(expected, -3); // within ~1 second
  });

  it("returns the latest future explicit reset when multiple lines exist (mixed stale + fresh)", () => {
    vi.setSystemTime(new Date("2026-06-01T11:00:00"));
    const output = [
      "usage limit reached",
      "limit will reset at 2026-06-01 10:00", // stale — in the past
      "limit will reset at 2026-06-01 13:00", // fresh — in the future
      "limit will reset at 2026-06-01 12:30", // fresh but earlier
    ].join("\n");
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(false);
    expect(result?.resetAt.getHours()).toBe(13); // latest future one
    expect(result?.resetAt.getMinutes()).toBe(0);
  });

  it("falls back to duration when all explicit resets are stale and duration is present", () => {
    vi.setSystemTime(new Date("2026-06-02T12:00:00"));
    const output = [
      "usage limit reached",
      "limit will reset at 2026-06-01 10:00", // stale
      "usage limit reached for 30 minutes",
    ].join("\n");
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(true);
    const expected = Date.now() + 30 * 60_000;
    expect(result?.resetAt.getTime()).toBeCloseTo(expected, -3);
  });

  it("parses duration in hours", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const result = parseRateLimitReset("usage limit reached for 3 hours");
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(true);
    const expected = Date.now() + 3 * 3_600_000;
    expect(result?.resetAt.getTime()).toBeCloseTo(expected, -3);
  });

  it("parses duration in minutes", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const result = parseRateLimitReset("usage limit reached for 45 min");
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(true);
    const expected = Date.now() + 45 * 60_000;
    expect(result?.resetAt.getTime()).toBeCloseTo(expected, -3);
  });

  it("rejects malformed explicit reset timestamps with overflowed fields", () => {
    // Date("2026-99-99 99:99") would silently normalize to a different date.
    // Round-trip validation should reject it.
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const output = "usage limit reached\nlimit will reset at 2026-99-99 99:99";
    // No valid explicit reset; no duration fallback either → null
    expect(parseRateLimitReset(output)).toBeNull();
  });

  it("falls back to duration when explicit timestamp has overflowed fields", () => {
    vi.setSystemTime(new Date("2026-06-01T08:00:00"));
    const output = [
      "usage limit reached",
      "limit will reset at 2026-99-99 99:99", // overflow — should be rejected
      "usage limit reached for 1 hour",
    ].join("\n");
    const result = parseRateLimitReset(output);
    expect(result).not.toBeNull();
    expect(result?.isDurationBased).toBe(true);
    const expected = Date.now() + 3_600_000;
    expect(result?.resetAt.getTime()).toBeCloseTo(expected, -3);
  });
});

// ---------------------------------------------------------------------------
// setProjectPause / clearProjectPause — provenance key tests
// ---------------------------------------------------------------------------

describe("setProjectPause and clearProjectPause", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    // generateConfigHash calls realpathSync — file must exist
    writeFileSync(makeConfigPath(), "# test\n", "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes provenance keys (UNTIL, REASON, SOURCE) for explicit-timestamp pauses; no CREATED_AT", () => {
    const configPath = makeConfigPath();
    const project = makeProject();
    const sessionsDir = getSessionsDir(configPath, project.path);
    const orchId = "app-orchestrator";
    writeOrchestratorSeed(sessionsDir, orchId);

    const until = new Date(Date.now() + 3_600_000);
    setProjectPause(configPath, project, "app-1", until); // isDurationBased defaults to false

    const raw = readMetadataRaw(sessionsDir, orchId);
    expect(raw).not.toBeNull();
    expect(raw![GLOBAL_PAUSE_UNTIL_KEY]).toBe(until.toISOString());
    expect(raw![GLOBAL_PAUSE_REASON_KEY]).toContain("app-1");
    expect(raw![GLOBAL_PAUSE_SOURCE_KEY]).toBe("app-1");
    // CREATED_AT is NOT written for explicit-timestamp pauses — they don't need a grace window
    // because their timestamp becomes stale naturally once it passes.
    expect(raw![GLOBAL_PAUSE_CREATED_AT_KEY]).toBeUndefined();
  });

  it("writes CREATED_AT when isDurationBased is true (enables grace-window guard)", () => {
    const configPath = makeConfigPath();
    const project = makeProject();
    const sessionsDir = getSessionsDir(configPath, project.path);
    const orchId = "app-orchestrator";
    writeOrchestratorSeed(sessionsDir, orchId);

    const until = new Date(Date.now() + 3_600_000);
    setProjectPause(configPath, project, "app-1", until, true);

    const raw = readMetadataRaw(sessionsDir, orchId);
    expect(raw).not.toBeNull();
    expect(raw![GLOBAL_PAUSE_UNTIL_KEY]).toBe(until.toISOString());
    expect(raw![GLOBAL_PAUSE_SOURCE_KEY]).toBe("app-1");
    expect(raw![GLOBAL_PAUSE_CREATED_AT_KEY]).toBeDefined();
  });

  it("clearProjectPause removes REASON but preserves UNTIL, SOURCE, and CREATED_AT", () => {
    const configPath = makeConfigPath();
    const project = makeProject();
    const sessionsDir = getSessionsDir(configPath, project.path);
    const orchId = "app-orchestrator";
    writeOrchestratorSeed(sessionsDir, orchId);

    const until = new Date(Date.now() + 3_600_000);
    // Use isDurationBased = true so CREATED_AT is written (needed for grace-window test)
    setProjectPause(configPath, project, "app-1", until, true);
    clearProjectPause(configPath, project);

    const raw = readMetadataRaw(sessionsDir, orchId);
    expect(raw).not.toBeNull();
    // REASON cleared
    expect(raw![GLOBAL_PAUSE_REASON_KEY]).toBeUndefined();
    // UNTIL, SOURCE, CREATED_AT preserved for grace-window guard
    expect(raw![GLOBAL_PAUSE_UNTIL_KEY]).toBe(until.toISOString());
    expect(raw![GLOBAL_PAUSE_SOURCE_KEY]).toBe("app-1");
    expect(raw![GLOBAL_PAUSE_CREATED_AT_KEY]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// detectAndApplyRateLimitPause — grace-window guard tests
// ---------------------------------------------------------------------------

describe("detectAndApplyRateLimitPause", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    // generateConfigHash calls realpathSync — file must exist
    writeFileSync(makeConfigPath(), "# test\n", "utf-8");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a pause when no prior pause exists", async () => {
    vi.setSystemTime(new Date("2026-06-01T10:00:00"));
    const configPath = makeConfigPath();
    const project = makeProject();
    const sessionsDir = getSessionsDir(configPath, project.path);
    const orchId = "app-orchestrator";
    writeOrchestratorSeed(sessionsDir, orchId);

    const session = makeSession({ id: "app-1" });
    const mockRuntime: Runtime = {
      getOutput: vi.fn().mockResolvedValue(
        "usage limit reached\nlimit will reset at 2026-06-01 12:00",
      ),
    } as unknown as Runtime;
    const mockSessionManager: SessionManager = {
      get: vi.fn().mockResolvedValue({
        id: orchId,
        metadata: readMetadataRaw(sessionsDir, orchId) ?? {},
      }),
    } as unknown as SessionManager;

    await detectAndApplyRateLimitPause(configPath, session, project, mockRuntime, mockSessionManager);

    const raw = readMetadataRaw(sessionsDir, orchId);
    expect(raw![GLOBAL_PAUSE_UNTIL_KEY]).toBeDefined();
    expect(raw![GLOBAL_PAUSE_SOURCE_KEY]).toBe("app-1");
  });

  it("does not re-apply a pause within the grace window (project-wide, any session)", async () => {
    // A different session (app-2) tries to re-apply a pause immediately after a
    // recently-expired duration-based pause from app-1. The grace window should block it.
    const now = new Date("2026-06-01T10:00:00").getTime();
    vi.setSystemTime(now);

    const configPath = makeConfigPath();
    const project = makeProject();
    const sessionsDir = getSessionsDir(configPath, project.path);
    const orchId = "app-orchestrator";
    writeOrchestratorSeed(sessionsDir, orchId);

    // Simulate a recently-expired 1-hour pause created by app-1 at 09:00
    const createdAt = new Date(now - 3_600_000); // 09:00
    const expiredUntil = new Date(now - 1_000); // expired 1 second ago
    writeFileSync(
      join(sessionsDir, orchId),
      [
        "status=active",
        "branch=main",
        "worktree=/tmp/x",
        `${GLOBAL_PAUSE_UNTIL_KEY}=${expiredUntil.toISOString()}`,
        `${GLOBAL_PAUSE_CREATED_AT_KEY}=${createdAt.toISOString()}`,
        `${GLOBAL_PAUSE_SOURCE_KEY}=app-1`,
      ].join("\n") + "\n",
      "utf-8",
    );

    // app-2 now sees a fresh duration-based rate limit message
    const session2 = makeSession({ id: "app-2" });
    const mockRuntime: Runtime = {
      getOutput: vi.fn().mockResolvedValue("usage limit reached for 1 hour"),
    } as unknown as Runtime;
    const mockSessionManager: SessionManager = {
      get: vi.fn().mockResolvedValue({
        id: orchId,
        metadata: readMetadataRaw(sessionsDir, orchId) ?? {},
      }),
    } as unknown as SessionManager;

    await detectAndApplyRateLimitPause(configPath, session2, project, mockRuntime, mockSessionManager);

    // Grace window should prevent re-apply
    const raw = readMetadataRaw(sessionsDir, orchId);
    // UNTIL should still be the expired value (not a new future timestamp)
    expect(raw![GLOBAL_PAUSE_UNTIL_KEY]).toBe(expiredUntil.toISOString());
  });

  it("treats an invalid CREATED_AT timestamp as 'in grace period' (prevents re-pause)", async () => {
    vi.setSystemTime(new Date("2026-06-01T10:00:00"));
    const configPath = makeConfigPath();
    const project = makeProject();
    const sessionsDir = getSessionsDir(configPath, project.path);
    const orchId = "app-orchestrator";
    writeOrchestratorSeed(sessionsDir, orchId);

    const expiredUntil = new Date(Date.now() - 1_000); // expired 1 second ago
    writeFileSync(
      join(sessionsDir, orchId),
      [
        "status=active",
        "branch=main",
        "worktree=/tmp/x",
        `${GLOBAL_PAUSE_UNTIL_KEY}=${expiredUntil.toISOString()}`,
        `${GLOBAL_PAUSE_CREATED_AT_KEY}=not-a-valid-date`,
        `${GLOBAL_PAUSE_SOURCE_KEY}=app-1`,
      ].join("\n") + "\n",
      "utf-8",
    );

    const session = makeSession({ id: "app-1" });
    const mockRuntime: Runtime = {
      getOutput: vi.fn().mockResolvedValue("usage limit reached for 1 hour"),
    } as unknown as Runtime;
    const mockSessionManager: SessionManager = {
      get: vi.fn().mockResolvedValue({
        id: orchId,
        metadata: readMetadataRaw(sessionsDir, orchId) ?? {},
      }),
    } as unknown as SessionManager;

    await detectAndApplyRateLimitPause(configPath, session, project, mockRuntime, mockSessionManager);

    // Invalid CREATED_AT → treat as in grace period → no re-pause
    const raw = readMetadataRaw(sessionsDir, orchId);
    expect(raw![GLOBAL_PAUSE_UNTIL_KEY]).toBe(expiredUntil.toISOString());
  });
});
