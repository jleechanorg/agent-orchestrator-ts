import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PatternSynthesizer } from "../pattern-synthesizer.js";

function makeOutcome(
  trigger: string,
  action: string,
  success: boolean,
  durationMs?: number,
  projectId = "proj-1",
): string {
  return JSON.stringify({
    sessionId: `sess-${randomUUID().slice(0, 8)}`,
    projectId,
    trigger,
    action,
    success,
    durationMs,
    recordedAt: new Date().toISOString(),
  });
}

describe("PatternSynthesizer", () => {
  let tmpDir: string;
  let outcomesPath: string;
  let patternsPath: string;
  let synth: PatternSynthesizer;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pattern-synth-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    outcomesPath = join(tmpDir, "outcomes.jsonl");
    patternsPath = join(tmpDir, "patterns.json");
    synth = new PatternSynthesizer({ outcomesPath, patternsPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("synthesize produces empty patterns from empty outcomes file", async () => {
    writeFileSync(outcomesPath, "", "utf-8");
    await synth.synthesize();
    const patterns = await synth.getAllPatterns();
    expect(patterns).toEqual([]);
  });

  it("synthesize handles missing outcomes file (creates empty PatternStore)", async () => {
    // outcomesPath does not exist
    await synth.synthesize();
    const patterns = await synth.getAllPatterns();
    expect(patterns).toEqual([]);
    expect(existsSync(patternsPath)).toBe(true);
  });

  it("synthesize groups outcomes by trigger and calculates correct win rates", async () => {
    const lines: string[] = [];
    // 6 outcomes for ci-failed + retry: 5 success, 1 fail → winRate 5/6 ≈ 0.833
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("ci-failed", "retry", true, 1000));
    lines.push(makeOutcome("ci-failed", "retry", false));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const pattern = await synth.getPattern("ci-failed");
    expect(pattern).not.toBeNull();
    expect(pattern!.trigger).toBe("ci-failed");
    expect(pattern!.bestAction).toBe("retry");
    expect(pattern!.winRate).toBeCloseTo(5 / 6, 2);
    expect(pattern!.sampleCount).toBe(6);
  });

  it("synthesize filters out low-sample patterns (below minSamples)", async () => {
    const lines: string[] = [];
    // Only 3 outcomes for "rare-error" — below default minSamples=5
    for (let i = 0; i < 3; i++) lines.push(makeOutcome("rare-error", "fix", true, 500));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const pattern = await synth.getPattern("rare-error");
    expect(pattern).toBeNull();
  });

  it("synthesize assigns confidence levels correctly", async () => {
    const lines: string[] = [];
    // high confidence: 9/10 success → winRate 0.9 → high
    for (let i = 0; i < 9; i++) lines.push(makeOutcome("build-fail", "rebuild", true, 200));
    lines.push(makeOutcome("build-fail", "rebuild", false));

    // medium confidence: 6/10 success → winRate 0.6 → medium
    for (let i = 0; i < 6; i++) lines.push(makeOutcome("test-fail", "rerun", true, 300));
    for (let i = 0; i < 4; i++) lines.push(makeOutcome("test-fail", "rerun", false));

    // low confidence: 3/10 success → winRate 0.3 → low
    for (let i = 0; i < 3; i++) lines.push(makeOutcome("flaky", "ignore", true, 100));
    for (let i = 0; i < 7; i++) lines.push(makeOutcome("flaky", "ignore", false));

    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");
    await synth.synthesize();

    const highP = await synth.getPattern("build-fail");
    expect(highP!.confidence).toBe("high");

    const medP = await synth.getPattern("test-fail");
    expect(medP!.confidence).toBe("medium");

    const lowP = await synth.getPattern("flaky");
    expect(lowP!.confidence).toBe("low");
  });

  it("synthesize calculates average duration from successful outcomes only", async () => {
    const lines: string[] = [];
    // 5 successes with durationMs: 100, 200, 300, 400, 500 → avg = 300
    for (let i = 1; i <= 5; i++) lines.push(makeOutcome("ci-failed", "patch", true, i * 100));
    // 2 failures with durationMs that should be ignored
    lines.push(makeOutcome("ci-failed", "patch", false, 9999));
    lines.push(makeOutcome("ci-failed", "patch", false, 8888));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const pattern = await synth.getPattern("ci-failed");
    expect(pattern!.avgDurationMs).toBe(300);
  });

  it("synthesize writes patterns.json (verify file exists and is valid JSON)", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("deploy-fail", "rollback", true, 500));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    expect(existsSync(patternsPath)).toBe(true);

    const raw = await import("node:fs").then((fs) => fs.readFileSync(patternsPath, "utf-8"));
    const store = JSON.parse(raw);
    expect(store).toHaveProperty("patterns");
    expect(store).toHaveProperty("synthesizedAt");
    expect(store).toHaveProperty("outcomeCount");
    expect(Array.isArray(store.patterns)).toBe(true);
  });

  it("getPattern returns pattern for known trigger", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(makeOutcome("lint-fail", "autofix", true, 150));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const pattern = await synth.getPattern("lint-fail");
    expect(pattern).not.toBeNull();
    expect(pattern!.trigger).toBe("lint-fail");
    expect(pattern!.bestAction).toBe("autofix");
  });

  it("getPattern returns null for unknown trigger", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("known", "act", true, 100));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const result = await synth.getPattern("unknown-trigger");
    expect(result).toBeNull();
  });

  it("getPattern returns null when patterns.json does not exist", async () => {
    const result = await synth.getPattern("anything");
    expect(result).toBeNull();
  });

  it("getBestStrategy returns highest win-rate action string", async () => {
    const lines: string[] = [];
    // "retry" has winRate 4/6 ≈ 0.67, "escalate" has winRate 5/6 ≈ 0.83
    for (let i = 0; i < 4; i++) lines.push(makeOutcome("ci-failed", "retry", true, 100));
    for (let i = 0; i < 2; i++) lines.push(makeOutcome("ci-failed", "retry", false));
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("ci-failed", "escalate", true, 200));
    lines.push(makeOutcome("ci-failed", "escalate", false));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const best = await synth.getBestStrategy("ci-failed");
    expect(best).toBe("escalate");
  });

  it("getBestStrategy returns null when no patterns exist", async () => {
    const result = await synth.getBestStrategy("nonexistent");
    expect(result).toBeNull();
  });

  it("confidenceThreshold option adjusts confidence levels", async () => {
    // With threshold 0.9: high≥0.9, medium≥0.5625
    const customSynth = new PatternSynthesizer({
      outcomesPath,
      patternsPath,
      confidenceThreshold: 0.9,
    });
    const lines: string[] = [];
    // winRate 0.83 → would be "high" at default 0.8, but "medium" at 0.9
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("build-fail", "rebuild", true, 200));
    lines.push(makeOutcome("build-fail", "rebuild", false));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await customSynth.synthesize();
    const pattern = await customSynth.getPattern("build-fail");
    expect(pattern).not.toBeNull();
    expect(pattern!.confidence).toBe("medium");
  });

  it("getAllPatterns returns all synthesized patterns", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("ci-failed", "retry", true, 100));
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("lint-fail", "autofix", true, 200));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const all = await synth.getAllPatterns();
    expect(all).toHaveLength(2);
    const triggers = all.map((p) => p.trigger).sort();
    expect(triggers).toEqual(["ci-failed", "lint-fail"]);
  });

  it("synthesize groups by projectId so same trigger in different projects yields separate patterns", async () => {
    const lines: string[] = [];
    // proj-a: ci-failed → retry with 100% win rate
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("ci-failed", "retry", true, 100, "proj-a"));
    // proj-b: ci-failed → escalate with 100% win rate
    for (let i = 0; i < 5; i++) lines.push(makeOutcome("ci-failed", "escalate", true, 200, "proj-b"));
    writeFileSync(outcomesPath, lines.join("\n"), "utf-8");

    await synth.synthesize();
    const all = await synth.getAllPatterns();
    // Both share trigger "ci-failed" but come from different projects → 2 patterns
    expect(all).toHaveLength(2);
    const actions = all.map((p) => p.bestAction).sort();
    expect(actions).toEqual(["escalate", "retry"]);
  });

  it("writeStore creates parent directories when they do not exist", async () => {
    const deepPath = join(tmpDir, "nested", "deep", "patterns.json");
    const deepSynth = new PatternSynthesizer({
      outcomesPath,
      patternsPath: deepPath,
    });
    writeFileSync(outcomesPath, "", "utf-8");
    await deepSynth.synthesize();
    expect(existsSync(deepPath)).toBe(true);
    const content = JSON.parse(readFileSync(deepPath, "utf-8"));
    expect(content).toHaveProperty("patterns");
  });

  it("readStore returns null when pattern elements lack required fields", async () => {
    // Write a store with invalid pattern elements (missing required fields)
    writeFileSync(
      patternsPath,
      JSON.stringify({
        patterns: [{ trigger: "ci-failed" }], // missing bestAction, winRate
        synthesizedAt: new Date().toISOString(),
        outcomeCount: 1,
      }),
      "utf-8",
    );
    const result = await synth.getAllPatterns();
    expect(result).toEqual([]);
  });

  it("readStore accepts valid pattern elements", async () => {
    writeFileSync(
      patternsPath,
      JSON.stringify({
        patterns: [
          {
            trigger: "ci-failed",
            bestAction: "retry",
            winRate: 0.9,
            sampleCount: 10,
            avgDurationMs: 100,
            confidence: "high",
          },
        ],
        synthesizedAt: new Date().toISOString(),
        outcomeCount: 10,
      }),
      "utf-8",
    );
    const result = await synth.getAllPatterns();
    expect(result).toHaveLength(1);
    expect(result[0].trigger).toBe("ci-failed");
  });
});
