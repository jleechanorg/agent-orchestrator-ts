import { describe, it, expect } from "vitest";
import { createInitialState, nextPhase } from "@jleechanorg/ao-autonomous-harness";

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
});
