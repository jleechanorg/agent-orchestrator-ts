import { describe, it, expect } from "vitest";
import { computeLoadOrder, type LoadOrderEntry } from "../plugin-load-order.js";

describe("computeLoadOrder", () => {
  it("returns entries in slot priority order when no dependencies", () => {
    const entries: LoadOrderEntry[] = [
      { slot: "agent", name: "claude-code", pkg: "ao-plugin-agent-claude-code" },
      { slot: "runtime", name: "tmux", pkg: "ao-plugin-runtime-tmux" },
    ];

    const order = computeLoadOrder(entries);
    expect(order[0]!.slot).toBe("runtime");
    expect(order[1]!.slot).toBe("agent");
  });

  it("loads dependency before dependent", () => {
    const entries: LoadOrderEntry[] = [
      { slot: "agent", name: "claude-code", pkg: "ao-plugin-agent-claude-code", dependsOn: [{ slot: "runtime", name: "tmux" }] },
      { slot: "runtime", name: "tmux", pkg: "ao-plugin-runtime-tmux" },
    ];

    const order = computeLoadOrder(entries);
    const runtimeIndex = order.findIndex((e) => e.name === "tmux");
    const agentIndex = order.findIndex((e) => e.name === "claude-code");
    expect(runtimeIndex).toBeLessThan(agentIndex);
  });

  it("handles empty input", () => {
    const order = computeLoadOrder([]);
    expect(order).toEqual([]);
  });
});
