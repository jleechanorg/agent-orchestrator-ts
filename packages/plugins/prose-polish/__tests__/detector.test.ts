import { describe, it, expect } from "vitest";
import {
  detectNotXRepetition,
  detectForcedRuleOf3,
  detectWeakOpenings,
  detectFillers,
  detectRedundantPhrases,
  detectWeaselWords,
  detectRepeatedStarters,
  detectProximityRepetition,
  scanLines,
} from "../src/detector.js";

describe("detectNotXRepetition", () => {
  it("flags 3+ Not X lines", () => {
    const lines = [
      "Not ambition.",
      "Not greed.",
      "Not spite.",
      "He was done.",
    ];
    const matches = detectNotXRepetition(lines);
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores fewer than 3 Not X lines", () => {
    const lines = ["Not ambition.", "Not greed.", "Done."];
    expect(detectNotXRepetition(lines).length).toBe(0);
  });
});

describe("detectForcedRuleOf3", () => {
  it("detects structurally identical triplets", () => {
    const lines = [
      "The hero fell.",
      "The villain fell.",
      "The crowd fell.",
    ];
    const matches = detectForcedRuleOf3(lines);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("detectWeakOpenings", () => {
  it("flags 'There is' openings", () => {
    const matches = detectWeakOpenings(["There is a reason."]);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("flags 'It is' openings", () => {
    const matches = detectWeakOpenings(["It is the end."]);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("passes normal sentence openings", () => {
    const matches = detectWeakOpenings(["The door opened."]);
    expect(matches.length).toBe(0);
  });
});

describe("detectFillers", () => {
  it("detects filler words", () => {
    const matches = detectFillers(["He was literally amazing."]);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("marks filler issues as autoFixable", () => {
    const matches = detectFillers(["It was basically done."]);
    expect(matches[0].autoFixable).toBe(true);
  });
});

describe("detectRedundantPhrases", () => {
  it("detects redundant phrases", () => {
    const matches = detectRedundantPhrases([
      "It was a very unique situation.",
    ]);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].autoFixable).toBe(true);
  });
});

describe("detectWeaselWords", () => {
  it("detects weasel words", () => {
    const matches = detectWeaselWords(["There were many reasons."]);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("detectRepeatedStarters", () => {
  it("flags same first word in 3 consecutive lines", () => {
    const lines = [
      "The door opened.",
      "The light was blinding.",
      "The silence was deafening.",
    ];
    const matches = detectRepeatedStarters(lines);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("detectProximityRepetition", () => {
  it("flags word repeated 3+ times in 10-line window", () => {
    const lines = [
      "The shadow moved.",
      "The shadow grew.",
      "The shadow consumed.",
      "Something else.",
    ];
    const matches = detectProximityRepetition(lines, 10);
    expect(matches.some(m => m.rule === "proximity-repetition")).toBe(true);
  });
});

describe("scanLines", () => {
  it("returns summary counts", () => {
    const result = scanLines("test.md", [
      "There is a problem.",
      "It is unclear.",
      "Very unique.",
    ]);
    expect(typeof result.totalLines).toBe("number");
    expect(typeof result.summary.critical).toBe("number");
    expect(typeof result.summary.warn).toBe("number");
    expect(typeof result.summary.info).toBe("number");
  });
});
