/**
 * stalled-worker-auditor.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  auditStalledWorkers,
  formatEloopCoverageReport,
  type StalledWorkerAuditorDeps,
  type StalledWorkerRecord,
} from "../stalled-worker-auditor.js";
import { resetIdleCycles } from "../stuck-worker-detector.js";
import type { SessionManager, ProjectConfig, Session } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_TMUX_SESSIONS = [
  {
    name: "aabbccddeeff-ao-42",
    attached: false,
    created: "Mon Mar 23 12:00:00 2026",
  },
  {
    name: "deadbeef123456-jc-7",
    attached: false,
    created: "Mon Mar 23 10:00:00 2026",
  },
  {
    name: "user-manual-session",
    attached: true,
    created: "Mon Mar 23 08:00:00 2026",
  },
];

function makeMockSession(id: string, projectId = "agent-orchestrator"): Session {
  return {
    id,
    sessionName: id,
    tmuxName: `aabbccddeeff-${id}`,
    projectId,
    status: "working",
    activityState: "active",
    createdAt: new Date().toISOString(),
    metadata: {},
  };
}

function makeMockProject(projectId: string, hasReaction = true): ProjectConfig {
  return {
    name: projectId,
    repo: `jleechanorg/${projectId}`,
    path: `/tmp/${projectId}`,
    defaultBranch: "main",
    sessionPrefix: projectId.slice(0, 2),
    workspace: "worktree",
    worktreeDir: `/tmp/worktrees/${projectId}`,
    agentConfig: { permissions: "skip" },
    reactions: hasReaction
      ? {
          "agent-stuck": {
            auto: true,
            threshold: "15m",
            action: "send-to-agent",
            message: "You appear to be stuck. Continue working.",
            retries: 3,
          },
        }
      : {},
  } as unknown as ProjectConfig;
}

// ─── Mock implementations ────────────────────────────────────────────────────

const mockListSessions = vi.fn();
const mockCapturePane = vi.fn();
const mockKillSession = vi.fn();
const mockSendKeys = vi.fn();
const mockSessionManagerList = vi.fn();
const mockSessionManagerGet = vi.fn();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("auditStalledWorkers", () => {
  beforeEach(() => {
    // mockReset clears implementation AND return value — critical for test isolation
    mockListSessions.mockReset();
    mockCapturePane.mockReset();
    mockKillSession.mockReset();
    mockSendKeys.mockReset();
    mockSessionManagerList.mockReset();
    mockSessionManagerGet.mockReset();

    // Clear module-level idle cycle state between tests
    resetIdleCycles();

    // Default: list all mock AO sessions
    mockListSessions.mockResolvedValue(MOCK_TMUX_SESSIONS);
    // Default: sessionManager.get returns a mock session for any ID
    mockSessionManagerGet.mockImplementation((id: string) =>
      Promise.resolve(makeMockSession(id)),
    );
    // Default: pane capture returns empty (not stalled)
    mockCapturePane.mockResolvedValue("");
    // Default: killSession and sendKeys are no-ops
    mockKillSession.mockResolvedValue(undefined);
    mockSendKeys.mockResolvedValue(undefined);
    mockSessionManagerList.mockResolvedValue([]);
  });

  it("skips attached tmux sessions", async () => {
    // An attached session (someone actively using it) — should be skipped
    const attachedSession = { name: "aabbccddeeff-ao-99", attached: true, created: "Mon Mar 23 12:00:00 2026" };
    mockListSessions.mockResolvedValue([attachedSession]);
    // sessionManager.get should NOT be called for attached sessions
    mockSessionManagerGet.mockResolvedValue(null);

    const deps = buildDeps();
    const report = await auditStalledWorkers(deps);

    expect(report.totalSessions).toBe(1);
    expect(report.aoManagedSessions).toBe(0);
    expect(mockSessionManagerGet).not.toHaveBeenCalled();
  });

  it("skips tmux sessions that don't parse as AO-managed", async () => {
    // A tmux session not matching the {12-hex-hash}-{prefix}-{num} pattern
    const nonAoSession = { name: "my-random-session", attached: false, created: "Mon Mar 23 12:00:00 2026" };
    mockListSessions.mockResolvedValue([nonAoSession]);

    const deps = buildDeps();
    const report = await auditStalledWorkers(deps);

    expect(report.aoManagedSessions).toBe(0);
  });

  it("detects stalled workers via pane content (shell prompt = dead agent)", async () => {
    // Session with shell prompt (no activity indicators) → verdict: kill
    mockCapturePane.mockResolvedValue("user@host ~/dir$");
    mockListSessions.mockResolvedValue([MOCK_TMUX_SESSIONS[0]]); // ao-42
    mockSessionManagerGet.mockImplementation((id: string) =>
      Promise.resolve(makeMockSession(id, "agent-orchestrator")),
    );

    // idleCycleOverride=3 bypasses the 3-cycle threshold so inspection fires immediately
    const deps = buildDeps({ idleCycleOverride: 3 });
    const report = await auditStalledWorkers(deps);

    expect(report.aoManagedSessions).toBe(1);
    expect(report.stalledWorkers.some((r) => r.verdict.action === "kill")).toBe(true);
  });

  it("flags projects without agent-stuck reaction as gap", async () => {
    // Pane shows shell prompt (stalled) + session's project has NO reaction
    mockCapturePane.mockResolvedValue("user@host ~/dir$");
    mockListSessions.mockResolvedValue([MOCK_TMUX_SESSIONS[0]]); // ao-42
    mockSessionManagerGet.mockImplementation((id: string) =>
      Promise.resolve(makeMockSession(id, "no-reaction-project")),
    );

    const deps = buildDeps({
      projects: new Map([["no-reaction-project", makeMockProject("no-reaction-project", false)]]),
      idleCycleOverride: 3,
    });
    const report = await auditStalledWorkers(deps);

    // Session's projectId is "no-reaction-project" — project has no reaction → flagged
    expect(report.projectsWithoutReaction).toContain("no-reaction-project");
    expect(report.unhandledGaps.length).toBeGreaterThan(0);
  });

  it("marks session with agent-stuck reaction as having eloop coverage", async () => {
    // Pane shows stalled (shell prompt), but project HAS agent-stuck reaction
    mockCapturePane.mockResolvedValue("user@host ~/dir$");
    mockListSessions.mockResolvedValue([MOCK_TMUX_SESSIONS[0]]); // ao-42
    mockSessionManagerGet.mockImplementation((id: string) =>
      Promise.resolve(makeMockSession(id, "agent-orchestrator")),
    );

    // agent-orchestrator project has agent-stuck reaction
    const deps = buildDeps({ idleCycleOverride: 3 });
    const report = await auditStalledWorkers(deps);

    // ao-42 should be in stalledWorkers with hasEloopReaction=true
    const record = report.stalledWorkers.find((r) => r.sessionId === "ao-42");
    expect(record).toBeDefined();
    expect(record!.hasEloopReaction).toBe(true);
  });
});

describe("formatEloopCoverageReport", () => {
  it("shows no stalled workers when all are healthy", () => {
    const report = buildReport({ stalledWorkers: [], unhandledGaps: [] });
    const output = formatEloopCoverageReport(report);
    expect(output).toContain("No stalled workers detected");
  });

  it("shows unhandled gaps", () => {
    const stalled: StalledWorkerRecord = {
      sessionId: "ao-42",
      tmuxName: "aabbccddeeff-ao-42",
      projectId: "agent-orchestrator",
      projectPath: "/tmp/agent-orchestrator",
      verdict: { action: "kill", reason: "agent CLI exited" },
      hasEloopReaction: false,
      eloopHandling: false,
      panePreview: "user@host$",
      ageMs: 600_000,
    };
    const report = buildReport({ stalledWorkers: [stalled], unhandledGaps: [stalled] });
    const output = formatEloopCoverageReport(report);
    expect(output).toContain("Stalled workers: 1");
    expect(output).toContain("Eloop gaps");
    expect(output).toContain("ao-42");
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDeps(overrides: Partial<StalledWorkerAuditorDeps> = {}): StalledWorkerAuditorDeps {
  return {
    sessionManager: {
      list: mockSessionManagerList,
      get: mockSessionManagerGet,
      kill: vi.fn(),
      send: vi.fn(),
      touch: vi.fn(),
      attach: vi.fn(),
    } as unknown as SessionManager,
    projects: new Map([["agent-orchestrator", makeMockProject("agent-orchestrator")]]),
    idleCycleThreshold: 3,
    idleCycleOverride: undefined,
    capturePane: mockCapturePane,
    listSessions: mockListSessions,
    dryRun: true,
    log: vi.fn(),
    ...overrides,
  };
}

function buildReport(overrides: Partial<import("../stalled-worker-auditor.js").EloopCoverageReport>): import("../stalled-worker-auditor.js").EloopCoverageReport {
  return {
    scannedAt: new Date(),
    totalSessions: 1,
    aoManagedSessions: 1,
    stalledWorkers: [],
    unhandledGaps: [],
    allRecords: [],
    projectsWithoutReaction: [],
    ...overrides,
  };
}
