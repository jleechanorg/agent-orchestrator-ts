/**
 * stalled-worker-auditor.test.ts
 * Tests for stalled-worker-auditor.ts
 */

import { describe, it, expect } from "vitest";
import { formatEloopCoverageReport } from "../stalled-worker-auditor.js";
import type { StalledWorkerRecord, EloopCoverageReport } from "../stalled-worker-auditor.js";

function makeReport(overrides: Partial<EloopCoverageReport> = {}): EloopCoverageReport {
  return {
    scannedAt: new Date("2026-04-04T10:00:00Z"),
    totalSessions: 5,
    aoManagedSessions: 3,
    stalledWorkers: [],
    unhandledGaps: [],
    allRecords: [],
    projectsWithoutReaction: [],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<StalledWorkerRecord> = {}): StalledWorkerRecord {
  return {
    sessionId: "ao-42",
    tmuxName: "aabbccddeeff-ao-42",
    projectId: "agent-orchestrator",
    projectPath: "/tmp/agent-orchestrator",
    verdict: { action: "none", reason: "no signal" },
    hasEloopReaction: true,
    eloopHandling: false,
    panePreview: "",
    ageMs: 0,
    ...overrides,
  };
}

describe("formatEloopCoverageReport", () => {
  it("shows healthy when no stalled workers", () => {
    const report = makeReport({ stalledWorkers: [], unhandledGaps: [] });
    const output = formatEloopCoverageReport(report);
    expect(output).toContain("No stalled workers detected");
    expect(output).toContain("Eloop coverage complete");
  });

  it("shows stalled worker count and verdict", () => {
    const stalled: StalledWorkerRecord[] = [
      makeRecord({
        verdict: { action: "kill", reason: "agent CLI exited" },
        panePreview: "user@host$",
      }),
    ];
    const report = makeReport({ stalledWorkers: stalled, unhandledGaps: stalled });
    const output = formatEloopCoverageReport(report);

    expect(output).toContain("Stalled workers: 1");
    expect(output).toContain("ao-42");
    expect(output).toContain("kill");
    expect(output).toContain("Eloop gaps");
  });

  it("shows action labels for kill/nudge/none", () => {
    const workers: StalledWorkerRecord[] = [
      makeRecord({ sessionId: "ao-1", verdict: { action: "kill", reason: "exited" } }),
      makeRecord({ sessionId: "ao-2", verdict: { action: "nudge", reason: "waiting" } }),
      makeRecord({ sessionId: "ao-3", verdict: { action: "none", reason: "active" } }),
    ];
    const report = makeReport({ stalledWorkers: workers, unhandledGaps: [] });
    const output = formatEloopCoverageReport(report);

    expect(output).toContain("ao-1");
    expect(output).toContain("ao-2");
    expect(output).toContain("ao-3");
  });

  it("flags projects without agent-stuck reaction", () => {
    const report = makeReport({ projectsWithoutReaction: ["worldarchitect", "ralph"] });
    const output = formatEloopCoverageReport(report);

    expect(output).toContain("Projects WITHOUT agent-stuck reaction");
    expect(output).toContain("worldarchitect");
    expect(output).toContain("ralph");
  });

  it("shows eloop NOT handling when reaction missing", () => {
    const stalled: StalledWorkerRecord[] = [
      makeRecord({
        verdict: { action: "kill", reason: "exited" },
        hasEloopReaction: false,
        eloopHandling: false,
      }),
    ];
    const report = makeReport({ stalledWorkers: stalled, unhandledGaps: stalled });
    const output = formatEloopCoverageReport(report);

    expect(output).toContain("eloop NOT handling");
    expect(output).toContain("No agent-stuck reaction configured");
  });

  it("includes pane preview for stalled workers", () => {
    const stalled: StalledWorkerRecord[] = [
      makeRecord({
        verdict: { action: "kill", reason: "exited" },
        panePreview: "user@host ~/projects/agent$ npm run build",
      }),
    ];
    const report = makeReport({ stalledWorkers: stalled, unhandledGaps: stalled });
    const output = formatEloopCoverageReport(report);

    expect(output).toContain("Last pane");
  });

  it("shows total session count", () => {
    const report = makeReport({ totalSessions: 10, aoManagedSessions: 6 });
    const output = formatEloopCoverageReport(report);

    expect(output).toContain("10 total");
    expect(output).toContain("6 AO-managed");
  });
});
