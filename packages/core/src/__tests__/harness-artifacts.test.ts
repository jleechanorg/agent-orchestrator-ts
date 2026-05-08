import { describe, it, expect } from "vitest";
import {
  validateHarnessArtifact,
  validateResearchArtifact,
  validatePlanArtifact,
  validateHandoffArtifact,
  classifyContextUtilization,
  computePlanProgress,
  initContextMonitorState,
  updateContextMonitorState,
  incrementContextResetCount,
  shouldContextReset,
  CONTEXT_THRESHOLDS,
  researchToMarkdown,
  planToMarkdown,
  handoffToMarkdown,
} from "../harness-artifacts.js";

describe("harness-artifacts: schema validation", () => {
  describe("validateResearchArtifact", () => {
    it("passes a valid research artifact", () => {
      const artifact = {
        artifactType: "research",
        featureName: "Add authentication",
        sessionStartedAt: "2026-05-07T10:00:00Z",
        completedAt: "2026-05-07T10:30:00Z",
        sections: [{ heading: "Auth flow", body: "Found the auth module" }],
        constraints: [],
        potentialIssues: [],
        references: [],
        openQuestions: [],
      };
      const result = validateResearchArtifact(artifact);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("fails when artifactType is not 'research'", () => {
      const artifact = { artifactType: "plan", featureName: "Test" };
      const result = validateResearchArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("research"))).toBe(true);
    });

    it("fails when featureName is empty", () => {
      const artifact = {
        artifactType: "research",
        featureName: "   ",
        sessionStartedAt: "2026-05-07T10:00:00Z",
        completedAt: "2026-05-07T10:30:00Z",
        sections: [],
        constraints: [],
        potentialIssues: [],
        references: [],
        openQuestions: [],
      };
      const result = validateResearchArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("featureName"))).toBe(true);
    });

    it("fails on invalid timestamp", () => {
      const artifact = {
        artifactType: "research",
        featureName: "Test",
        sessionStartedAt: "not-a-timestamp",
        completedAt: "2026-05-07T10:30:00Z",
        sections: [],
        constraints: [],
        potentialIssues: [],
        references: [],
        openQuestions: [],
      };
      const result = validateResearchArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("sessionStartedAt"))).toBe(true);
    });
  });

  describe("validatePlanArtifact", () => {
    it("passes a valid plan artifact", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Add feature X",
        createdAt: "2026-05-07T10:00:00Z",
        updatedAt: "2026-05-07T10:30:00Z",
        overview: "Implement feature X by modifying files A and B",
        todos: [
          { id: "task-1", description: "Update file A", status: "pending" },
          { id: "task-2", description: "Update file B", status: "pending", dependsOn: ["task-1"] },
        ],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(true);
    });

    it("fails when todo id is missing", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Test",
        createdAt: "2026-05-07T10:00:00Z",
        updatedAt: "2026-05-07T10:30:00Z",
        overview: "Overview text",
        todos: [{ id: "", description: "Task with empty id", status: "pending" }],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(false);
    });

    it("fails on duplicate todo ids", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Test",
        createdAt: "2026-05-07T10:00:00Z",
        updatedAt: "2026-05-07T10:30:00Z",
        overview: "Overview text",
        todos: [
          { id: "task-1", description: "First task", status: "pending" },
          { id: "task-1", description: "Duplicate id", status: "pending" },
        ],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
    });

    it("fails on invalid todo status", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Test",
        createdAt: "2026-05-07T10:00:00Z",
        updatedAt: "2026-05-07T10:30:00Z",
        overview: "Overview",
        todos: [{ id: "task-1", description: "Task", status: "maybe" as PlanTodoItem["status"] }],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("status"))).toBe(true);
    });

    it("fails when overview is empty", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Test",
        createdAt: "2026-05-07T10:00:00Z",
        updatedAt: "2026-05-07T10:30:00Z",
        overview: "",
        todos: [],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("overview"))).toBe(true);
    });

    it("fails when createdAt is missing", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Test",
        updatedAt: "2026-05-07T10:30:00Z",
        overview: "Valid overview",
        todos: [],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("createdAt"))).toBe(true);
    });

    it("fails when updatedAt is not a valid ISO timestamp", () => {
      const artifact = {
        artifactType: "plan",
        featureName: "Test",
        createdAt: "2026-05-07T10:00:00Z",
        updatedAt: "not-a-timestamp",
        overview: "Valid overview",
        todos: [],
        gradingCriteria: [],
        openQuestions: [],
      };
      const result = validatePlanArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("updatedAt"))).toBe(true);
    });
  });

  describe("validateHandoffArtifact", () => {
    it("passes a valid handoff artifact", () => {
      const artifact = {
        artifactType: "handoff",
        featureName: "Feature X",
        createdAt: "2026-05-07T10:00:00Z",
        triggerReason: "context threshold hit",
        contextUtilizationPct: 71,
        originatingSessionId: "session-1",
        nextTodoId: "task-2",
        nextStepDescription: "Continue from task-2",
        currentState: [{ heading: "Files changed", body: "Modified A.ts" }],
        openIssues: [],
        contextNotes: [],
        resetCount: 1,
      };
      const result = validateHandoffArtifact(artifact);
      expect(result.valid).toBe(true);
    });

    it("fails when contextUtilizationPct is out of range", () => {
      const artifact = {
        artifactType: "handoff",
        featureName: "Test",
        createdAt: "2026-05-07T10:00:00Z",
        triggerReason: "threshold",
        contextUtilizationPct: 150,
        nextTodoId: "task-1",
        nextStepDescription: "Next step",
        currentState: [],
        openIssues: [],
        contextNotes: [],
        resetCount: 1,
      };
      const result = validateHandoffArtifact(artifact);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("contextUtilizationPct"))).toBe(true);
    });
  });

  describe("validateHarnessArtifact (discriminator)", () => {
    it("routes to research validator", () => {
      const artifact = {
        artifactType: "research",
        featureName: "X",
        sessionStartedAt: "2026-05-07T10:00:00Z",
        completedAt: "2026-05-07T10:30:00Z",
        sections: [],
        constraints: [],
        potentialIssues: [],
        references: [],
        openQuestions: [],
      };
      const result = validateHarnessArtifact(artifact);
      expect(result.valid).toBe(true);
      expect(result.artifactType).toBe("research");
    });

    it("returns error for unknown artifactType", () => {
      const result = validateHarnessArtifact({ artifactType: "unknown" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unknown artifactType"))).toBe(true);
    });

    it("returns error for non-object input", () => {
      const result = validateHarnessArtifact(null);
      expect(result.valid).toBe(false);
    });
  });
});

describe("harness-artifacts: plan progress", () => {
  it("computes progress from todo list", () => {
    const todos: PlanTodoItem[] = [
      { id: "1", description: "a", status: "completed" },
      { id: "2", description: "b", status: "completed" },
      { id: "3", description: "c", status: "in_progress" },
      { id: "4", description: "d", status: "pending" },
      { id: "5", description: "e", status: "skipped" },
    ];
    const progress = computePlanProgress(todos);
    expect(progress.total).toBe(5);
    expect(progress.completed).toBe(2);
    expect(progress.inProgress).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.skipped).toBe(1);
  });

  it("handles empty todo list", () => {
    const progress = computePlanProgress([]);
    expect(progress.total).toBe(0);
    expect(progress.completed).toBe(0);
    expect(progress.pending).toBe(0);
  });
});

describe("harness-artifacts: context utilization classification", () => {
  it("classifies nominal below 60%", () => {
    expect(classifyContextUtilization(0)).toBe("nominal");
    expect(classifyContextUtilization(59)).toBe("nominal");
    expect(classifyContextUtilization(59.9)).toBe("nominal");
  });

  it("classifies warning between 60% and 70%", () => {
    expect(classifyContextUtilization(60)).toBe("warning");
    expect(classifyContextUtilization(69)).toBe("warning");
    expect(classifyContextUtilization(69.9)).toBe("warning");
  });

  it("classifies trigger at 70% and above until 90%", () => {
    expect(classifyContextUtilization(70)).toBe("trigger");
    expect(classifyContextUtilization(89)).toBe("trigger");
  });

  it("classifies critical at 90% and above", () => {
    expect(classifyContextUtilization(90)).toBe("critical");
    expect(classifyContextUtilization(99)).toBe("critical");
    expect(classifyContextUtilization(100)).toBe("critical");
  });
});

describe("harness-artifacts: context monitor state", () => {
  it("initContextMonitorState sets initial values", () => {
    const state = initContextMonitorState();
    expect(state["contextUtilizationPct"]).toBe("0");
    expect(state["contextResetCount"]).toBe("0");
    expect(state["contextLevel"]).toBe("nominal");
    expect(state["contextLastRecorded"]).toBeTruthy();
  });

  it("updateContextMonitorState applies new utilization", () => {
    const state = initContextMonitorState();
    const updated = updateContextMonitorState(state, 65);
    expect(updated["contextUtilizationPct"]).toBe("65");
    expect(updated["contextLevel"]).toBe("warning");
  });

  it("updateContextMonitorState stores raw unrounded value", () => {
    const state = initContextMonitorState();
    const updated = updateContextMonitorState(state, 69.6);
    expect(updated["contextUtilizationPct"]).toBe("70");
    expect(updated["contextUtilizationRaw"]).toBe("69.60");
    // 69.6 is below RESET_TRIGGER_PCT=70 — classified as warning, not trigger
    expect(updated["contextLevel"]).toBe("warning");
  });

  it("updateContextMonitorState preserves reset count", () => {
    const state = { ...initContextMonitorState(), contextResetCount: "2" };
    const updated = updateContextMonitorState(state, 65);
    expect(updated["contextResetCount"]).toBe("2");
  });

  it("updateContextMonitorState preserves extra fields", () => {
    const state = { ...initContextMonitorState(), customField: "keep-me" };
    const updated = updateContextMonitorState(state, 65);
    expect(updated["customField"]).toBe("keep-me");
  });

  it("updateContextMonitorState triggers at 70%", () => {
    const state = initContextMonitorState();
    const updated = updateContextMonitorState(state, 71);
    expect(updated["contextUtilizationPct"]).toBe("71");
    expect(updated["contextLevel"]).toBe("trigger");
  });

  it("incrementContextResetCount increments the counter", () => {
    const state = initContextMonitorState();
    const incremented = incrementContextResetCount(state);
    expect(incremented["contextResetCount"]).toBe("1");

    const double = incrementContextResetCount(incremented);
    expect(double["contextResetCount"]).toBe("2");
  });

  it("incrementContextResetCount works from empty state", () => {
    const result = incrementContextResetCount({});
    expect(result["contextResetCount"]).toBe("1");
  });

  it("incrementContextResetCount preserves all other state fields", () => {
    const state = initContextMonitorState();
    const updated = updateContextMonitorState(state, 71);
    const incremented = incrementContextResetCount(updated);
    expect(incremented["contextUtilizationPct"]).toBe("71");
    expect(incremented["contextLevel"]).toBe("trigger");
    expect(incremented["contextResetCount"]).toBe("1");
    expect(incremented["contextUtilizationRaw"]).toBeTruthy();
    expect(incremented["contextLastRecorded"]).toBeTruthy();
  });
});

describe("harness-artifacts: shouldContextReset", () => {
  it("returns shouldTrigger false when nominal", () => {
    const state = initContextMonitorState();
    const result = shouldContextReset(state);
    expect(result.shouldTrigger).toBe(false);
    expect(result.level).toBe("nominal");
    expect(result.reason).toContain("nominal/warning");
  });

  it("returns shouldTrigger true when at trigger threshold", () => {
    const state = updateContextMonitorState(initContextMonitorState(), 72);
    const result = shouldContextReset(state);
    expect(result.shouldTrigger).toBe(true);
    expect(result.level).toBe("trigger");
    expect(result.reason).toContain("trigger threshold hit");
  });

  it("returns shouldTrigger true when critical", () => {
    const state = updateContextMonitorState(initContextMonitorState(), 95);
    const result = shouldContextReset(state);
    expect(result.shouldTrigger).toBe(true);
    expect(result.level).toBe("critical");
  });

  it("returns shouldTrigger false when max resets reached", () => {
    const state = {
      ...updateContextMonitorState(initContextMonitorState(), 95),
      contextResetCount: String(CONTEXT_THRESHOLDS.DEFAULT_MAX_RESETS),
    };
    const result = shouldContextReset(state);
    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toContain("max resets reached");
  });

  it("respects custom maxResets", () => {
    const state = {
      ...updateContextMonitorState(initContextMonitorState(), 72),
      contextResetCount: "2",
    };
    const result = shouldContextReset(state, 3);
    expect(result.shouldTrigger).toBe(true);

    const atLimit = { ...state, contextResetCount: "3" };
    const blocked = shouldContextReset(atLimit, 3);
    expect(blocked.shouldTrigger).toBe(false);
  });

  it("uses stored contextLevel not rounded pct to avoid false trigger", () => {
    // 69.6 rounds to 70, but storedLevel=warning (correctly classified at sample time).
    // shouldContextReset must use storedLevel, not recompute from rounded value.
    const state = {
      contextUtilizationPct: "70", // rounded from 69.6
      contextUtilizationRaw: "69.60",
      contextLevel: "warning", // correct classification at sample time
      contextResetCount: "0",
      contextLastRecorded: new Date().toISOString(),
    };
    const result = shouldContextReset(state);
    // stored level is "warning" — below trigger threshold
    expect(result.shouldTrigger).toBe(false);
    expect(result.level).toBe("warning");
  });
});

describe("harness-artifacts: markdown serialization", () => {
  it("researchToMarkdown produces valid markdown with sections", () => {
    const artifact = {
      artifactType: "research" as const,
      featureName: "Auth feature",
      sessionStartedAt: "2026-05-07T10:00:00Z",
      completedAt: "2026-05-07T10:30:00Z",
      model: "sonnet-4",
      sections: [{ heading: "Auth flow", body: "Found the auth module handles token refresh" }],
      constraints: [],
      potentialIssues: [],
      references: [{ path: "src/auth.ts", reason: "Main auth entry", range: "1-50" }],
      openQuestions: [{ question: "Should we use JWT?", context: "Current impl uses sessions" }],
    };
    const md = researchToMarkdown(artifact);
    expect(md).toContain("# Research: Auth feature");
    expect(md).toContain("## Codebase Understanding");
    expect(md).toContain("### Auth flow");
    expect(md).toContain("## References");
    expect(md).toContain("src/auth.ts");
    expect(md).toContain("## Open Questions");
  });

  it("planToMarkdown produces valid markdown with todos", () => {
    const artifact = {
      artifactType: "plan" as const,
      featureName: "Auth feature",
      createdAt: "2026-05-07T10:00:00Z",
      updatedAt: "2026-05-07T10:30:00Z",
      model: "opus",
      overview: "Implement auth by modifying src/auth.ts",
      approach: [{ heading: "Implementation", body: "Add JWT support" }],
      todos: [
        { id: "task-1", description: "Add JWT helper", status: "pending" },
        { id: "task-2", description: "Update middleware", status: "in_progress" },
        { id: "task-3", description: "Add tests", status: "completed" },
        { id: "task-4", description: "Skip optional step", status: "skipped" },
      ],
      gradingCriteria: [{ criterion: "Correctness", description: "Works for all cases", weight: 30 }],
      openQuestions: [],
    };
    const md = planToMarkdown(artifact);
    expect(md).toContain("# Plan: Auth feature");
    expect(md).toContain("## Overview");
    expect(md).toContain("## Todo List");
    // Status icons preserved
    expect(md).toContain("[ ] `task-1`: Add JWT helper");
    expect(md).toContain("[>] `task-2`: Update middleware");
    expect(md).toContain("[x] `task-3`: Add tests");
    expect(md).toContain("[s] `task-4`: Skip optional step");
    expect(md).toContain("## Grading Criteria");
  });

  it("handoffToMarkdown produces valid markdown with current state", () => {
    const artifact = {
      artifactType: "handoff" as const,
      featureName: "Auth feature",
      createdAt: "2026-05-07T10:00:00Z",
      triggerReason: "context threshold hit",
      contextUtilizationPct: 71,
      originatingSessionId: "session-42",
      nextTodoId: "task-2",
      nextStepDescription: "Continue from task-2",
      currentState: [{ heading: "Files modified", body: "Modified src/auth.ts and src/middleware.ts" }],
      openIssues: [{ heading: "Skeptic critique", body: "Missing test coverage" }],
      contextNotes: [],
      resetCount: 2,
      maxResets: 5,
    };
    const md = handoffToMarkdown(artifact);
    expect(md).toContain("# Handoff: Auth feature");
    expect(md).toContain("**Trigger**: context threshold hit (71% context used)");
    expect(md).toContain("**Reset**: #2 / 5 max");
    expect(md).toContain("## Session Resume Point");
    expect(md).toContain("**Next todo**: `task-2`");
    expect(md).toContain("## Current State");
    expect(md).toContain("## Open Issues");
  });
});