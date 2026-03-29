import { describe, it, expect } from "vitest";
import { buildActionPlan, formatActionPlan } from "../action-plan.js";
import type { MergeGateResult } from "../merge-gate.js";

describe("buildActionPlan", () => {
  it("returns empty plan when all gates pass", () => {
    const result: MergeGateResult = {
      passed: true,
      checks: [
        { name: "CI green", passed: true, detail: "CI is passing" },
        { name: "Mergeable", passed: true, detail: "No merge conflicts" },
        { name: "CodeRabbit approved", passed: true, detail: "Approved" },
        { name: "Bugbot clean", passed: true, detail: "No Bugbot errors" },
        { name: "Inline comments resolved", passed: true, detail: "All comments resolved" },
        { name: "Evidence review pass", passed: true, detail: "Evidence review not required" },
        { name: "Skeptic approved", passed: true, detail: "Skeptic approved" },
      ],
      blockers: [],
    };

    const plan = buildActionPlan(result);

    expect(plan.ready).toBe(true);
    expect(plan.items).toHaveLength(0);
  });

  it("returns single action for one failing gate (merge conflict)", () => {
    const result: MergeGateResult = {
      passed: false,
      checks: [
        { name: "CI green", passed: true, detail: "CI is passing" },
        { name: "Mergeable", passed: false, detail: "Merge conflicts detected" },
        { name: "CodeRabbit approved", passed: true, detail: "Approved" },
        { name: "Bugbot clean", passed: true, detail: "No Bugbot errors" },
        { name: "Inline comments resolved", passed: true, detail: "All comments resolved" },
        { name: "Evidence review pass", passed: true, detail: "Evidence review not required" },
        { name: "Skeptic approved", passed: true, detail: "Skeptic approved" },
      ],
      blockers: ["Mergeable"],
    };

    const plan = buildActionPlan(result);

    expect(plan.ready).toBe(false);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].gate).toBe("Mergeable");
    expect(plan.items[0].priority).toBe(1);
    expect(plan.items[0].action).toBeTruthy();
    expect(plan.items[0].reason).toBeTruthy();
  });

  it("orders actions by priority ascending (merge conflict first, then CI, then CR)", () => {
    const result: MergeGateResult = {
      passed: false,
      checks: [
        { name: "CI green", passed: false, detail: "CI failed" },
        { name: "Mergeable", passed: true, detail: "No merge conflicts" },
        { name: "CodeRabbit approved", passed: false, detail: "Changes requested" },
        { name: "Bugbot clean", passed: true, detail: "No Bugbot errors" },
        { name: "Inline comments resolved", passed: true, detail: "All comments resolved" },
        { name: "Evidence review pass", passed: true, detail: "Evidence review not required" },
        { name: "Skeptic approved", passed: true, detail: "Skeptic approved" },
      ],
      blockers: ["CI green", "CodeRabbit approved"],
    };

    const plan = buildActionPlan(result);

    expect(plan.ready).toBe(false);
    expect(plan.items).toHaveLength(2);
    // Priority 1 (mergeable) should come before priority 2 (CI green)
    // CI green is priority 2, CodeRabbit approved is priority 5
    expect(plan.items[0].gate).toBe("CI green");
    expect(plan.items[0].priority).toBe(2);
    expect(plan.items[1].gate).toBe("CodeRabbit approved");
    expect(plan.items[1].priority).toBe(5);
  });

  it("assigns priority 99 to unknown gate names", () => {
    const result: MergeGateResult = {
      passed: false,
      checks: [
        { name: "CI green", passed: true, detail: "CI is passing" },
        { name: "Mergeable", passed: true, detail: "No merge conflicts" },
        { name: "Unknown gate", passed: false, detail: "Unknown check failed" },
      ],
      blockers: ["Unknown gate"],
    };

    const plan = buildActionPlan(result);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].priority).toBe(99);
  });

  it("formats plan as numbered checklist", () => {
    const result: MergeGateResult = {
      passed: false,
      checks: [
        { name: "Mergeable", passed: false, detail: "Merge conflicts detected" },
        { name: "CI green", passed: false, detail: "CI status: failing" },
        { name: "CodeRabbit approved", passed: true, detail: "" },
        { name: "Bugbot clean", passed: true, detail: "" },
        { name: "Inline comments resolved", passed: true, detail: "" },
        { name: "Evidence review pass", passed: true, detail: "" },
        { name: "Skeptic approved", passed: true, detail: "" },
      ],
      blockers: ["Mergeable", "CI green"],
    };
    const plan = buildActionPlan(result);
    const text = formatActionPlan(plan);
    expect(text).toContain("ACTION PLAN");
    expect(text).toContain("1.");
    expect(text).toContain("2.");
    expect(text).toContain("Mergeable");
    expect(text).toContain("CI green");
    expect(text).not.toContain("CodeRabbit approved");
  });

  it("returns empty string for ready plan", () => {
    const plan = { items: [], ready: true };
    expect(formatActionPlan(plan)).toBe("");
  });

  it("handles empty checks array", () => {
    const result: MergeGateResult = {
      passed: true,
      checks: [],
      blockers: [],
    };

    const plan = buildActionPlan(result);

    expect(plan.ready).toBe(true);
    expect(plan.items).toHaveLength(0);
  });

  it("sorts all failing gates by priority ascending", () => {
    const result: MergeGateResult = {
      passed: false,
      checks: [
        { name: "Skeptic approved", passed: false, detail: "Skeptic verdict: FAIL" },
        { name: "Evidence review pass", passed: false, detail: "No evidence review approval" },
        { name: "CodeRabbit approved", passed: false, detail: "Changes requested" },
        { name: "Inline comments resolved", passed: false, detail: "5 unresolved comments" },
        { name: "Bugbot clean", passed: false, detail: "3 Bugbot errors" },
        { name: "CI green", passed: false, detail: "CI failed" },
        { name: "Mergeable", passed: false, detail: "Merge conflicts detected" },
      ],
      blockers: [
        "Mergeable",
        "CI green",
        "Bugbot clean",
        "Inline comments resolved",
        "CodeRabbit approved",
        "Evidence review pass",
        "Skeptic approved",
      ],
    };

    const plan = buildActionPlan(result);

    expect(plan.items).toHaveLength(7);
    const priorities = plan.items.map((i) => i.priority);
    expect(priorities).toEqual([...priorities].sort());
    // Verify specific order
    expect(plan.items[0].gate).toBe("Mergeable");
    expect(plan.items[0].priority).toBe(1);
    expect(plan.items[1].gate).toBe("CI green");
    expect(plan.items[1].priority).toBe(2);
    expect(plan.items[2].gate).toBe("Bugbot clean");
    expect(plan.items[2].priority).toBe(3);
    expect(plan.items[3].gate).toBe("Inline comments resolved");
    expect(plan.items[3].priority).toBe(4);
    expect(plan.items[4].gate).toBe("CodeRabbit approved");
    expect(plan.items[4].priority).toBe(5);
    expect(plan.items[5].gate).toBe("Evidence review pass");
    expect(plan.items[5].priority).toBe(6);
    expect(plan.items[6].gate).toBe("Skeptic approved");
    expect(plan.items[6].priority).toBe(7);
  });
});
