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
import {
  sweepOrphanTmuxSessions,
  DEFAULT_AO_SESSION_PREFIXES,
  DEFAULT_TMUX_SWEEPER_CONFIG,
  type TmuxSweeperConfig,
  type TmuxSweeperDeps,
} from "../tmux-session-sweeper.js";
import type { SessionManager, Session } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_NOW = new Date("2025-03-23T12:00:00Z");
const THIRTY_MIN_MS = 1_800_000;
const FORTY_MIN_MS = 2_400_000;

function tmuxSession(
  name: string,
  createdMsAgo = -FORTY_MIN_MS,
  attached = false,
) {
  return {
    name,
    created: new Date(BASE_NOW.getTime() + createdMsAgo).toString(),
    attached,
    windows: 1,
  };
}

function aoSession(id: string, tmuxName?: string): Session {
  return {
    id,
    tmuxName,
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
    aoSessionPrefixes: DEFAULT_AO_SESSION_PREFIXES,
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

describe("DEFAULT_AO_SESSION_PREFIXES", () => {
  it("contains all expected AO prefixes", () => {
    expect(DEFAULT_AO_SESSION_PREFIXES.has("ao")).toBe(true);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("jc")).toBe(true);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("wa")).toBe(true);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("cc")).toBe(true);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("ra")).toBe(true);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("wc")).toBe(true);
  });

  it("does not contain non-AO prefixes", () => {
    expect(DEFAULT_AO_SESSION_PREFIXES.has("foo")).toBe(false);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("main")).toBe(false);
    expect(DEFAULT_AO_SESSION_PREFIXES.has("")).toBe(false);
  });
});

describe("DEFAULT_TMUX_SWEEPER_CONFIG", () => {
  it("defaults to 30-minute orphan threshold", () => {
    expect(DEFAULT_TMUX_SWEEPER_CONFIG.orphanIdleThresholdMs).toBe(1_800_000);
  });

  it("defaults to 10 max kills per sweep", () => {
    expect(DEFAULT_TMUX_SWEEPER_CONFIG.maxKillsPerSweep).toBe(10);
  });

  it("defaults to DEFAULT_AO_SESSION_PREFIXES", () => {
    expect(DEFAULT_TMUX_SWEEPER_CONFIG.aoSessionPrefixes).toBe(DEFAULT_AO_SESSION_PREFIXES);
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

  it("AO session without hash prefix is not recognized (parseTmuxName returns null)", async () => {
    mockListSessions.mockResolvedValueOnce([tmuxSession("ao-42")]);
    mockParseTmuxName.mockReturnValueOnce(null);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(0);
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("AO session with non-AO prefix is not recognized", async () => {
    // parseTmuxName returns a valid parse but prefix "app" is not in allowed prefixes
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "app", num: 42 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-app-42")]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(0);
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  it("AO-named session with valid prefix and orphan status is killed", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 42 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-42")]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.scanned).toBe(1);
    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].tmuxName).toBe("aabbccddeeff-ao-42");
    expect(result.killed[0].aoSessionId).toBe("ao-42");
  });

  it("custom aoSessionPrefixes overrides the default prefixes", async () => {
    // "app-99" should be recognized when "app" is in the custom prefix set
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "app", num: 99 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-app-99")]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(
      cfg({ aoSessionPrefixes: new Set(["app", "backend"]) }),
      deps(sm()),
    );

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].aoSessionId).toBe("app-99");
  });

  // -------------------------------------------------------------------------
  // AO DB presence exemption
  // -------------------------------------------------------------------------

  it("AO-named session tracked in AO DB is skipped", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "jc", num: 99 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-jc-99")]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm([aoSession("jc-99", "aabbccddeeff-jc-99")])));

    expect(result.killed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("tracked in AO DB");
  });

  it("AO-named session not in AO DB is a kill candidate", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "wa", num: 7 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-wa-7")]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Attached session guard
  // -------------------------------------------------------------------------

  it("attached session is skipped even if not in AO DB", async () => {
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-5", -FORTY_MIN_MS, true)]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("session is attached");
    expect(result.killed).toHaveLength(0);
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idle-time threshold behavior
  // -------------------------------------------------------------------------

  it("orphan under 30-min threshold → skipped", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "cc", num: 5 });
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
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 1 });
    // Created 40 minutes ago (past 30-minute threshold)
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-1", -FORTY_MIN_MS)]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed).toHaveLength(1);
    expect(result.killed[0].tmuxName).toBe("aabbccddeeff-ao-1");
    expect(result.killed[0].aoSessionId).toBe("ao-1");
    expect(mockKillSession).toHaveBeenCalledWith("aabbccddeeff-ao-1");
  });

  it("unparseable created date → treated as 0ms idle (safe default, skipped)", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 1 });
    mockListSessions.mockResolvedValueOnce([{ name: "aabbccddeeff-ao-1", created: "not a valid date", attached: false, windows: 1 }]);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    // Unparseable date → 0ms idle → below threshold → skipped
    expect(result.killed).toHaveLength(0);
    expect(result.skipped.some((s) => s.reason.includes("not yet idle"))).toBe(true);
    expect(mockKillSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Kill action for true orphans
  // -------------------------------------------------------------------------

  it("kills orphan tmux session via killSession", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "wc", num: 3 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-wc-3", -FORTY_MIN_MS)]);
    mockKillSession.mockResolvedValueOnce(undefined);

    await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(mockKillSession).toHaveBeenCalledTimes(1);
    expect(mockKillSession).toHaveBeenCalledWith("aabbccddeeff-wc-3");
  });

  it("reports correct aoSessionId in killed result", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "112233445566", prefix: "jc", num: 55 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("112233445566-jc-55", -FORTY_MIN_MS)]);
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.killed[0].aoSessionId).toBe("jc-55");
  });

  it("session-not-found kill error is benign (not captured as failure)", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 7 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-7", -FORTY_MIN_MS)]);
    mockKillSession.mockRejectedValueOnce(new Error("session not found: aabbccddeeff-ao-7"));

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.errors).toHaveLength(0);
    expect(result.killed).toHaveLength(0);
  });

  it("non-benign kill errors are captured in errors array", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 8 });
    mockListSessions.mockResolvedValueOnce([tmuxSession("aabbccddeeff-ao-8", -FORTY_MIN_MS)]);
    mockKillSession.mockRejectedValueOnce(new Error("permission denied: /tmp/tmux.sock"));

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].tmuxName).toBe("aabbccddeeff-ao-8");
    expect(result.errors[0].error).toContain("permission denied");
  });

  // -------------------------------------------------------------------------
  // maxKillsPerSweep cap (counting errors toward cap)
  // -------------------------------------------------------------------------

  it("kills up to maxKillsPerSweep, skips the rest", async () => {
    // 6 sessions all past threshold with errors counting toward cap
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 0 });
    mockListSessions.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, i) => tmuxSession(`aabbccddeeff-ao-${i}`, -FORTY_MIN_MS)),
    );
    // First 3 succeed, next 3 trigger non-benign errors
    mockKillSession
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("perm denied"))
      .mockRejectedValueOnce(new Error("perm denied"))
      .mockRejectedValueOnce(new Error("perm denied"));

    const result = await sweepOrphanTmuxSessions(cfg({ maxKillsPerSweep: 3 }), deps(sm()));

    // 3 killed + 0 errors = cap reached → 3 more sessions skipped
    expect(result.killed).toHaveLength(3);
    expect(result.errors).toHaveLength(0); // errors don't count when cap is reached at 3
    expect(mockKillSession).toHaveBeenCalledTimes(3);
    expect(result.skipped.some((s) => s.reason.includes("max kills"))).toBe(true);
  });

  it("errors count toward maxKillsPerSweep cap", async () => {
    // 3 orphans, cap=2:
    // 1st: kill succeeds → killed=1, errors=0 (total=1 < 2 → continue)
    // 2nd: kill fails with error → killed=1, errors=1 (total=2 >= 2 → cap hit)
    // 3rd: skipped (total=2 >= 2 cap)
    mockParseTmuxName.mockReturnValue({ hash: "aabbccddeeff", prefix: "ao", num: 0 });
    mockListSessions.mockResolvedValueOnce([
      tmuxSession("aabbccddeeff-ao-0", -FORTY_MIN_MS),
      tmuxSession("aabbccddeeff-ao-1", -FORTY_MIN_MS),
      tmuxSession("aabbccddeeff-ao-2", -FORTY_MIN_MS),
    ]);
    mockKillSession
      .mockResolvedValueOnce(undefined) // 1st: killed
      .mockRejectedValueOnce(new Error("perm denied")); // 2nd: error

    const result = await sweepOrphanTmuxSessions(cfg({ maxKillsPerSweep: 2 }), deps(sm()));

    expect(result.killed).toHaveLength(1);
    expect(result.errors).toHaveLength(1); // 2nd orphan: error, cap hit after
    expect(result.skipped.filter((s) => s.reason.includes("max kills"))).toHaveLength(1); // 3rd skipped
  });

  // -------------------------------------------------------------------------
  // dryRun
  // -------------------------------------------------------------------------

  it("dryRun=true does not call killSession", async () => {
    mockParseTmuxName.mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 9 });
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
    // Use mockImplementation to return the correct prefix for each call based on tmux name
    mockParseTmuxName.mockImplementation((name: string) => {
      const match = name.match(/^([0-9a-f]+)-([a-z]+)-(\d+)$/);
      if (!match) return null;
      const [, hash, prefix, num] = match;
      return { hash, prefix, num: Number(num) };
    });
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

  it("scanned count includes non-AO sessions and attached sessions", async () => {
    mockListSessions.mockResolvedValueOnce([
      tmuxSession("my-dev-session"),
      tmuxSession("aabbccddeeff-ao-1", -FORTY_MIN_MS, true), // attached
      tmuxSession("aabbccddeeff-ao-2", -FORTY_MIN_MS), // orphan
    ]);
    mockParseTmuxName
      .mockReturnValueOnce(null) // my-dev-session → not AO
      .mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 1 }) // ao-1 attached
      .mockReturnValueOnce({ hash: "aabbccddeeff", prefix: "ao", num: 2 }); // ao-2 orphan
    mockKillSession.mockResolvedValueOnce(undefined);

    const result = await sweepOrphanTmuxSessions(cfg(), deps(sm()));

    expect(result.scanned).toBe(3);
    // 1 attached skipped, 1 orphan killed
    expect(result.skipped.filter((s) => s.reason === "session is attached")).toHaveLength(1);
    expect(result.killed).toHaveLength(1);
  });
});
