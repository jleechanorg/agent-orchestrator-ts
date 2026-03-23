import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so we can reference mock functions inside vi.mock factory
// and also access them in beforeEach/afterEach for per-test setup.
const { listSessions: mockListSessions, killSession: mockKillSession } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  killSession: vi.fn(),
}));

// Use vi.hoisted for parseTmuxName mock so we can configure it per-test
const mockParseTmuxName = vi.hoisted(() => vi.fn());

// Mock modules before importing the sweeper under test
vi.mock("../tmux.js", () => ({
  listSessions: mockListSessions,
  killSession: mockKillSession,
  isTmuxAvailable: vi.fn(),
  hasSession: vi.fn(),
  newSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  getPaneTTY: vi.fn(),
}));

vi.mock("../paths.js", () => ({
  parseTmuxName: mockParseTmuxName,
  generateConfigHash: vi.fn(),
  generateTmuxName: vi.fn(),
  generateSessionName: vi.fn(),
  generateProjectId: vi.fn(),
  generateInstanceId: vi.fn(),
}));

// Import after mocking
import { sweepOrphanTmuxSessions, AO_SESSION_PREFIXES, DEFAULT_TMUX_SWEEPER_CONFIG, type TmuxSweeperConfig, type TmuxSweeperDeps } from "../tmux-session-sweeper.js";
import type { SessionManager, Session } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_NOW = new Date("2025-03-23T12:00:00Z");
const THIRTY_MIN_MS = 1_800_000;
const FORTY_MIN_MS = 2_400_000;

function tmuxSession(name: string, createdMsAgo = -FORTY_MIN_MS) {
  return {
    name,
    created: new Date(BASE_NOW.getTime() + createdMsAgo).toString(),
    attached: false,
    windows: 1,
  };
}

function aoSession(id: string): Session {
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
    createdAt: new Date(BASE_NOW.getTime() - FORTY_MIN_MS),
    lastActivityAt: new Date(BASE_NOW.getTime() - 60_000),
    metadata: {},
  };
}

function sm(activeSessions: Session[] = []): SessionManager {
  return {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue(activeSessions),
    get: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  } as unknown as SessionManager;
}

function cfg(overrides?: Partial<TmuxSweeperConfig>): TmuxSweeperConfig {
  return {
    orphanIdleThresholdMs: THIRTY_MIN_MS,
    maxKillsPerSweep: 10,
    ...overrides,
  };
}

function deps(s: SessionManager): TmuxSweeperDeps {
  return { sessionManager: s, now: BASE_NOW };
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  // Re-apply mock implementations after reset
  vi.mocked(mockListSessions).mockImplementation(vi.fn());
  vi.mocked(mockKillSession).mockImplementation(vi.fn());
  // Default: parseTmuxName returns null so non-matching names are handled safely
  vi.mocked(mockParseTmuxName).mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AO_SESSION_PREFIXES", () => {
  it("contains all expected AO prefixes", () => {
    expect(AO_SESSION_PREFIXES.has("ao")).toBe(true);
    expect(AO_SESSION_PREFIXES.has("jc")).toBe(true);
    expect(AO_SESSION_PREFIXES.has("wa")).toBe(true);
    expect(AO_SESSION_PREFIXES.has("cc")).toBe(true);
    expect(AO_SESSION_PREFIXES.has("ra")).toBe(true);
    expect(AO_SESSION_PREFIXES.has("wc")).toBe(true);
  });

  it("does not contain non-AO prefixes", () => {
    expect(AO_SESSION_PREFIXES.has("foo")).toBe(false);
    expect(AO_SESSION_PREFIXES.has("main")).toBe(false);
    expect(AO_SESSION_PREFIXES.has("")).toBe(false);
  });
});

describe("DEFAULT_TMUX_SWEEPER_CONFIG", () => {
  it("defaults to 30-minute orphan threshold", () => {
    expect(DEFAULT_TMUX_SWEEPER_CONFIG.orphanIdleThresholdMs).toBe(1_800_000);
  });

  it("defaults to 10 max kills per sweep", () => {
    expect(DEFAULT_TMUX_SWEEPER_CONFIG.maxKillsPerSweep).toBe(10);
  });

  it("dryRun is undefined by default", () => {
    expect(DEFAULT_TMUX_SWEEPER_CONFIG.dryRun).toBeUndefined();
  });
});

describe("sweepOrphanTmuxSessions", () => {
  // -------------------------------------------------------------------------
  // Pattern filtering
  // -------------------------------------------------------------------------

  it("non-AO-named tmux sessions are not scanned as orphans", async () => {
    mockListSessions.mockResolvedValueOnce([tmuxSession("my-dev-session")]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.scanned).toBe(1);
    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("AO-named session without hash prefix is not scanned as orphan", async () => {
    // "ao-42" doesn't match the 12-char hex hash pattern → parseTmuxName returns null
    mockListSessions.mockResolvedValueOnce([tmuxSession("ao-42")]);
    mockParseTmuxName.mockReturnValueOnce(null);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(0);
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("AO-named session with hash prefix is recognized and treated as orphan (not in DB)", async () => {
    // parseTmuxName called twice per session: isAoTmuxSession + aoSessionIdFromTmuxName
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 42 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-42")]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.scanned).toBe(1);
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].tmuxName).toBe("aabbccddeeff-ao-42");
    expect(result.killed[0].aoSessionId).toBe("ao-42");
  });

  // -------------------------------------------------------------------------
  // AO DB presence exemption
  // -------------------------------------------------------------------------

  it("AO-named session tracked in AO DB is skipped", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "jc", num: 99 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-jc-99")]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm([aoSession("jc-99")])));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("tracked in AO DB");
    expect(result.skipped[0].tmuxName).toBe("aabbccddeeff-jc-99");
  });

  it("AO-named session not in AO DB is a kill candidate", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "wa", num: 7 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-wa-7")]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Idle-time threshold behavior
  // -------------------------------------------------------------------------

  it("orphan under 30-min threshold → skipped", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "cc", num: 5 });
    // Created 20 minutes ago (under 30-minute threshold)
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-cc-5", -20 * 60_000)]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("not yet idle");
    expect(result.skipped[0].reason).toContain("20min");
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("orphan past 30-min threshold → killed", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 1 });
    // Created 40 minutes ago (past 30-minute threshold)
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-1", -FORTY_MIN_MS)]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].tmuxName).toBe("aabbccddeeff-ao-1");
    expect(result.killed[0].aoSessionId).toBe("ao-1");
    expect(mockKillSession).toHaveBeenCalledWith("aabbccddeeff-ao-1");
  });

  // -------------------------------------------------------------------------
  // Kill action for true orphans
  // -------------------------------------------------------------------------

  it("kills orphan tmux session via killSession", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "wc", num: 3 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-wc-3", -FORTY_MIN_MS)]);
    mockKillSession.mockResolvedValueOnce(undefined);

    await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(mockKillSession).toHaveBeenCalledTimes(1);
    expect(mockKillSession).toHaveBeenCalledWith("aabbccddeeff-wc-3");
  });

  it("reports correct aoSessionId in killed result", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "112233445566", prefix: "jc", num: 55 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("112233445566-jc-55", -FORTY_MIN_MS)]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed[0].aoSessionId).toBe("jc-55");
    expect(result.killed[0].tmuxName).toBe("112233445566-jc-55");
  });

  it("session-not-found kill error is benign (not captured as failure)", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 7 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-7", -FORTY_MIN_MS)]);
    mockKillSession.mockRejectedValueOnce(new Error("session not found: aabbccddeeff-ao-7"));

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.errors).toHaveLength(0);
    expect(result.killed).toHaveLength(0);
  });

  it("non-benign kill errors are captured in errors array", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 8 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-8", -FORTY_MIN_MS)]);
    mockKillSession.mockRejectedValueOnce(new Error("permission denied: /tmp/tmux.sock"));

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].tmuxName).toBe("aabbccddeeff-ao-8");
    expect(result.errors[0].error).toContain("permission denied");
  });

  // -------------------------------------------------------------------------
  // maxKillsPerSweep cap
  // -------------------------------------------------------------------------

  it("kills up to maxKillsPerSweep, skips the rest", async () => {
    const prefixList = ["ao", "jc", "wa", "cc", "ra", "wc"];
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 0 });
    mockListSessions.mockResolvedValueOnce(
      prefixList.map((p, i) => tmuxSession(`aabbccddeeff-${p}-${i}`, -FORTY_MIN_MS)),
    );
    mockKillSession.mockResolvedValue(undefined);

    const result = await sweepOrphanTmuxSessions(cfg({ maxKillsPerSweep: 3 }), deps(sm()));

    expect(result.killed).toHaveLength(3);
    expect(mockKillSession).toHaveBeenCalledTimes(3);
    expect(result.skipped.some((s) => s.reason.includes("max kills"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // dryRun
  // -------------------------------------------------------------------------

  it("dryRun=true does not call killSession", async () => {
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 9 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-9", -FORTY_MIN_MS)]);

    const result = await sweepOrphanTmuxSessions(cfg({ dryRun: true }), deps(sm()));

    expect(result.dryRun).toBe(true);
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].tmuxName).toBe("aabbccddeeff-ao-9");
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // All AO prefixes
  // -------------------------------------------------------------------------

  it("all six AO prefixes are recognized as orphans when untracked", async () => {
    const prefixList = ["ao", "jc", "wa", "cc", "ra", "wc"];
    mockParseTmuxName.mockReturnValue({ hash: "deadbeefcafe", prefix: "ao", num: 0 });
    mockListSessions.mockResolvedValueOnce(
      prefixList.map((p, i) => tmuxSession(`deadbeefcafe-${p}-${i + 1}`, -FORTY_MIN_MS)),
    );
    mockKillSession.mockResolvedValue(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(6);
    for (const p of prefixList) {
      expect(result.killed.some((k) => k.tmuxName.includes(`-${p}-`))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("empty tmux session list → empty result", async () => {
    mockListSessions.mockResolvedValueOnce([]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(result.dryRun).toBe(false);
  });

  it("scanned count includes non-AO sessions", async () => {
    mockListSessions.mockResolvedValueOnce([
      tmuxSession("my-dev-session"),
      tmuxSession("aabbccddeeff-ao-1", -FORTY_MIN_MS),
    ]);
    mockParseTmuxName
      .mockReturnValueOnce(null) // my-dev-session → isAoTmuxSession
      .mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 1 }) // ao-1 → isAoTmuxSession
      .mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 1 }); // ao-1 → aoSessionIdFromTmuxName
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.scanned).toBe(2);
    expect(result.killed).toHaveLength(1);
  });
});
