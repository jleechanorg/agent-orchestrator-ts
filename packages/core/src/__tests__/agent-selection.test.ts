import { describe, expect, it } from "vitest";
import { lookupCliModelDefaults, resolveAgentSelection } from "../agent-selection.js";

describe("lookupCliModelDefaults", () => {
  it("matches keys case-insensitively", () => {
    expect(lookupCliModelDefaults({ Codex: { model: "m1" } }, "codex")).toEqual({
      model: "m1",
    });
  });

  it("prefers exact key when present", () => {
    expect(
      lookupCliModelDefaults({ codex: { model: "exact" }, CODEX: { model: "other" } }, "codex"),
    ).toEqual({ model: "exact" });
  });

  it("returns empty when map is undefined", () => {
    expect(lookupCliModelDefaults(undefined, "x")).toEqual({});
  });
});

describe("resolveAgentSelection — modelByCli", () => {
  const baseProject = {
    name: "p",
    repo: "o/r",
    path: "/p",
    defaultBranch: "main",
    sessionPrefix: "s",
    agentConfig: {},
    orchestrator: {},
    worker: {},
  } as const;

  it("resolves model from modelByCli with case-insensitive key", () => {
    const out = resolveAgentSelection({
      role: "worker",
      project: { ...baseProject },
      defaults: {
        runtime: "t",
        agent: "mock-agent",
        workspace: "w",
        notifiers: [],
        modelByCli: {
          "MOCK-AGENT": { model: "cli-model" },
        },
      },
    });
    expect(out.model).toBe("cli-model");
  });
});
