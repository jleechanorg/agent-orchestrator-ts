import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { OutcomeRecorder } from "../outcome-recorder.js";
import type { RecordedOutcome } from "../types.js";

function makeOutcome(overrides: Partial<RecordedOutcome> = {}): RecordedOutcome {
  return {
    sessionId: randomUUID(),
    projectId: "proj-1",
    trigger: "ci-failed",
    action: "fix-lint",
    success: true,
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("OutcomeRecorder", () => {
  let testDir: string;
  let recorder: OutcomeRecorder;

  beforeEach(() => {
    testDir = join(tmpdir(), `outcome-recorder-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    recorder = new OutcomeRecorder({ storagePath: join(testDir, "outcomes.jsonl") });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("record appends outcome to file", () => {
    const outcome = makeOutcome();
    recorder.record(outcome);

    const content = readFileSync(join(testDir, "outcomes.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.sessionId).toBe(outcome.sessionId);
  });

  it("record creates file if it doesn't exist", () => {
    const nestedPath = join(testDir, "nested", "dir", "outcomes.jsonl");
    const rec = new OutcomeRecorder({ storagePath: nestedPath });

    rec.record(makeOutcome());
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("multiple record calls produce valid JSONL", () => {
    recorder.record(makeOutcome({ action: "a1" }));
    recorder.record(makeOutcome({ action: "a2" }));
    recorder.record(makeOutcome({ action: "a3" }));

    const content = readFileSync(join(testDir, "outcomes.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  it("query with no filters returns all outcomes", () => {
    recorder.record(makeOutcome());
    recorder.record(makeOutcome());
    recorder.record(makeOutcome());

    const results = recorder.query({});
    expect(results).toHaveLength(3);
  });

  it("query by trigger filters correctly", () => {
    recorder.record(makeOutcome({ trigger: "ci-failed" }));
    recorder.record(makeOutcome({ trigger: "pr-created" }));
    recorder.record(makeOutcome({ trigger: "ci-failed" }));

    const results = recorder.query({ trigger: "ci-failed" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.trigger).toBe("ci-failed"));
  });

  it("query by action filters correctly", () => {
    recorder.record(makeOutcome({ action: "fix-lint" }));
    recorder.record(makeOutcome({ action: "fix-test" }));
    recorder.record(makeOutcome({ action: "fix-lint" }));

    const results = recorder.query({ action: "fix-lint" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.action).toBe("fix-lint"));
  });

  it("query by projectId filters correctly", () => {
    recorder.record(makeOutcome({ projectId: "proj-1" }));
    recorder.record(makeOutcome({ projectId: "proj-2" }));
    recorder.record(makeOutcome({ projectId: "proj-1" }));

    const results = recorder.query({ projectId: "proj-1" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.projectId).toBe("proj-1"));
  });

  it("getWinRate returns correct percentage", () => {
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-lint", success: false }));

    const rate = recorder.getWinRate("ci-failed", "fix-lint");
    expect(rate).toBeCloseTo(2 / 3);
  });

  it("getWinRate returns 0 for unknown combo", () => {
    const rate = recorder.getWinRate("unknown-trigger", "unknown-action");
    expect(rate).toBe(0);
  });

  it("getTopStrategies ranks by win rate descending", () => {
    // fix-lint: 2/3 wins = 0.667
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-lint", success: false }));

    // fix-test: 3/3 wins = 1.0
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-test", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-test", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "fix-test", success: true }));

    const strategies = recorder.getTopStrategies("ci-failed");
    expect(strategies[0].action).toBe("fix-test");
    expect(strategies[0].winRate).toBe(1.0);
    expect(strategies[1].action).toBe("fix-lint");
    expect(strategies[1].winRate).toBeCloseTo(2 / 3);
  });

  it("getTopStrategies respects limit parameter", () => {
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "a1", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "a2", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", action: "a3", success: true }));

    const strategies = recorder.getTopStrategies("ci-failed", 2);
    expect(strategies).toHaveLength(2);
  });

  it("clear empties the file", () => {
    recorder.record(makeOutcome());
    recorder.record(makeOutcome());

    recorder.clear();

    const results = recorder.query({});
    expect(results).toHaveLength(0);

    const filePath = join(testDir, "outcomes.jsonl");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("");
  });
});
