import { describe, it, expect } from "vitest";
import {
  parseSkepticReport,
  computeOverallVerdict,
  buildFeedbackMessage,
  type SkepticReport,
  type CriterionVerdict,
} from "../skeptic-report.js";

describe("computeOverallVerdict", () => {
  it("returns PASS when all criteria pass", () => {
    const criteria: CriterionVerdict[] = [
      { criterion: "A", commandRun: "cmd", rawOutput: "ok", verdict: "PASS", reason: "Works" },
      { criterion: "B", commandRun: "cmd2", rawOutput: "ok", verdict: "PASS", reason: "Works" },
    ];
    expect(computeOverallVerdict(criteria)).toBe("PASS");
  });

  it("returns FAIL when any criterion fails", () => {
    const criteria: CriterionVerdict[] = [
      { criterion: "A", commandRun: "cmd", rawOutput: "ok", verdict: "PASS", reason: "Works" },
      { criterion: "B", commandRun: "cmd2", rawOutput: "err", verdict: "FAIL", reason: "Broken" },
    ];
    expect(computeOverallVerdict(criteria)).toBe("FAIL");
  });

  it("returns FAIL when FAIL and INSUFFICIENT both present", () => {
    const criteria: CriterionVerdict[] = [
      { criterion: "A", commandRun: null, rawOutput: null, verdict: "INSUFFICIENT", reason: "Ambiguous" },
      { criterion: "B", commandRun: "cmd", rawOutput: "err", verdict: "FAIL", reason: "Broken" },
    ];
    expect(computeOverallVerdict(criteria)).toBe("FAIL");
  });

  it("returns INSUFFICIENT when no FAIL but has NOT_ATTEMPTED", () => {
    const criteria: CriterionVerdict[] = [
      { criterion: "A", commandRun: "cmd", rawOutput: "ok", verdict: "PASS", reason: "Works" },
      { criterion: "B", commandRun: null, rawOutput: null, verdict: "NOT_ATTEMPTED", reason: "Tool missing" },
    ];
    expect(computeOverallVerdict(criteria)).toBe("INSUFFICIENT");
  });

  it("returns INSUFFICIENT when no FAIL but has INSUFFICIENT verdict", () => {
    const criteria: CriterionVerdict[] = [
      { criterion: "A", commandRun: "cmd", rawOutput: "ok", verdict: "PASS", reason: "Works" },
      { criterion: "B", commandRun: "cmd", rawOutput: "partial", verdict: "INSUFFICIENT", reason: "Unit tests only" },
    ];
    expect(computeOverallVerdict(criteria)).toBe("INSUFFICIENT");
  });

  it("returns INSUFFICIENT for empty criteria list", () => {
    expect(computeOverallVerdict([])).toBe("INSUFFICIENT");
  });
});

describe("parseSkepticReport", () => {
  it("parses valid report JSON", () => {
    const json = JSON.stringify({
      criteria: [
        { criterion: "Build passes", commandRun: "pnpm build", rawOutput: "exit 0", verdict: "PASS", reason: "Clean build" },
        { criterion: "Tests pass", commandRun: "pnpm test", rawOutput: "3 failed", verdict: "FAIL", reason: "Test failures" },
      ],
      overallVerdict: "FAIL",
      timestamp: "2026-03-24T10:00:00Z",
    });
    const report = parseSkepticReport(json);
    expect(report.criteria).toHaveLength(2);
    expect(report.criteria[0].verdict).toBe("PASS");
    expect(report.criteria[1].verdict).toBe("FAIL");
    expect(report.overallVerdict).toBe("FAIL");
    expect(report.timestamp).toBe("2026-03-24T10:00:00Z");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSkepticReport("not json")).toThrow();
  });

  it("throws on missing criteria field", () => {
    expect(() => parseSkepticReport(JSON.stringify({ overallVerdict: "PASS" }))).toThrow("criteria");
  });

  it("throws on invalid verdict value", () => {
    const json = JSON.stringify({
      criteria: [
        { criterion: "A", commandRun: null, rawOutput: null, verdict: "MAYBE", reason: "dunno" },
      ],
      overallVerdict: "FAIL",
      timestamp: "2026-03-24T10:00:00Z",
    });
    expect(() => parseSkepticReport(json)).toThrow("verdict");
  });

  it("accepts null commandRun and rawOutput", () => {
    const json = JSON.stringify({
      criteria: [
        { criterion: "A", commandRun: null, rawOutput: null, verdict: "NOT_ATTEMPTED", reason: "Cannot run" },
      ],
      overallVerdict: "INSUFFICIENT",
      timestamp: "2026-03-24T10:00:00Z",
    });
    const report = parseSkepticReport(json);
    expect(report.criteria[0].commandRun).toBeNull();
    expect(report.criteria[0].rawOutput).toBeNull();
  });
});

describe("buildFeedbackMessage", () => {
  it("includes failed criterion names and reasons", () => {
    const report: SkepticReport = {
      criteria: [
        { criterion: "Build passes", commandRun: "pnpm build", rawOutput: "ok", verdict: "PASS", reason: "Clean" },
        { criterion: "Tests pass", commandRun: "pnpm test", rawOutput: "3 failed", verdict: "FAIL", reason: "Test failures in auth module" },
        { criterion: "Docs updated", commandRun: null, rawOutput: null, verdict: "NOT_ATTEMPTED", reason: "No doc tool" },
      ],
      overallVerdict: "FAIL",
      timestamp: "2026-03-24T10:00:00Z",
    };
    const msg = buildFeedbackMessage(report);
    expect(msg).toContain("Tests pass");
    expect(msg).toContain("Test failures in auth module");
    expect(msg).toContain("FAIL");
  });

  it("includes INSUFFICIENT criteria in feedback", () => {
    const report: SkepticReport = {
      criteria: [
        { criterion: "E2E test", commandRun: "pnpm test", rawOutput: "unit only", verdict: "INSUFFICIENT", reason: "Unit tests shown for E2E criterion" },
      ],
      overallVerdict: "INSUFFICIENT",
      timestamp: "2026-03-24T10:00:00Z",
    };
    const msg = buildFeedbackMessage(report);
    expect(msg).toContain("E2E test");
    expect(msg).toContain("INSUFFICIENT");
  });

  it("returns summary for all-pass report", () => {
    const report: SkepticReport = {
      criteria: [
        { criterion: "Build passes", commandRun: "pnpm build", rawOutput: "ok", verdict: "PASS", reason: "Clean" },
      ],
      overallVerdict: "PASS",
      timestamp: "2026-03-24T10:00:00Z",
    };
    const msg = buildFeedbackMessage(report);
    expect(msg).toContain("PASS");
  });
});
