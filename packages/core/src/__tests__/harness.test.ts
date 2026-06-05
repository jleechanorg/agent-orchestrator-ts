import { describe, it, expect, vi } from "vitest";
import { createInitialState, nextPhase, spawnAOWorker } from "@jleechanorg/ao-autonomous-harness";

vi.mock("@jleechanorg/ao-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@jleechanorg/ao-core")>();
  return {
    ...original,
    loadConfig: () => ({
      projects: {
        "test-project": {
          path: "/tmp/correct-project-path",
        },
      },
    }),
  };
});

describe("Autonomous Harness state transitions", () => {
  it("transitions correctly through phases", () => {
    const state = createInitialState("/tmp/test", "test-project", 1);
    expect(state.currentSprint.phase).toBe("research");

    const state2 = nextPhase(state);
    expect(state2.currentSprint.phase).toBe("plan");

    const state3 = nextPhase(state2);
    expect(state3.currentSprint.phase).toBe("annotation");

    const state4 = nextPhase(state3);
    expect(state4.currentSprint.phase).toBe("implementation");

    const state5 = nextPhase(state4);
    expect(state5.currentSprint.phase).toBe("eval");

    const state6 = nextPhase(state5);
    expect(state6.currentSprint.phase).toBe("done");

    // Verify it remains "done" when advancing further
    const state7 = nextPhase(state6);
    expect(state7.currentSprint.phase).toBe("done");
  });

  it("spawnAOWorker rejects when project configuration path differs from workspace path", async () => {
    // If CLI workspace is '/tmp/wrong-project-path' but config is '/tmp/correct-project-path'
    await expect(
      spawnAOWorker({
        workspace: "/tmp/wrong-project-path",
        projectId: "test-project",
        systemPrompt: "test system prompt",
        taskPrompt: "test task prompt",
      }),
    ).rejects.toThrow("[autonomous-harness] Project path mismatch");
  });
});

