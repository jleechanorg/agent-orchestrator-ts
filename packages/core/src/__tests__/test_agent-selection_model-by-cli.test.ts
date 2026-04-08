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
    expect(out.agentConfig.model).toBe("cli-model");
    expect(out.agentName).toBe("mock-agent");
  });

  it("prefers project modelByCli over defaults modelByCli for the same agent", () => {
    const out = resolveAgentSelection({
      role: "worker",
      project: {
        ...baseProject,
        modelByCli: {
          "mock-agent": { model: "project-model" },
        },
      },
      defaults: {
        runtime: "t",
        agent: "mock-agent",
        workspace: "w",
        notifiers: [],
        modelByCli: {
          "MOCK-AGENT": { model: "default-model" },
        },
      },
    });

    expect(out.model).toBe("project-model");
    expect(out.agentConfig.model).toBe("project-model");
    expect(out.agentName).toBe("mock-agent");
  });

  it("uses CLI-specific worker model before generic shared model", () => {
    const out = resolveAgentSelection({
      role: "worker",
      project: {
        ...baseProject,
        agent: "codex",
        agentConfig: {
          model: "claude-sonnet-4-6",
        },
      },
      defaults: {
        runtime: "t",
        agent: "codex",
        workspace: "w",
        notifiers: [],
        modelByCli: {
          codex: { model: "gpt-5-codex" },
        },
      },
    });

    expect(out.agentName).toBe("codex");
    expect(out.model).toBe("gpt-5-codex");
    expect(out.agentConfig.model).toBe("gpt-5-codex");
  });

  it("prefers modelByCli over shared agentConfig.model for worker sessions", () => {
    const out = resolveAgentSelection({
      role: "worker",
      project: {
        ...baseProject,
        agentConfig: {
          model: "shared-model",
        },
        modelByCli: {
          "mock-agent": { model: "cli-model" },
        },
      },
      defaults: {
        runtime: "t",
        agent: "mock-agent",
        workspace: "w",
        notifiers: [],
      },
    });

    expect(out.model).toBe("cli-model");
    expect(out.agentConfig.model).toBe("cli-model");
  });

  it("uses CLI-specific orchestrator model before generic shared orchestrator model", () => {
    const out = resolveAgentSelection({
      role: "orchestrator",
      project: {
        ...baseProject,
        agent: "codex",
        agentConfig: {
          orchestratorModel: "claude-opus-4-20250514",
          model: "claude-sonnet-4-6",
        },
      },
      defaults: {
        runtime: "t",
        agent: "codex",
        workspace: "w",
        notifiers: [],
        modelByCli: {
          codex: { orchestratorModel: "gpt-5-codex" },
        },
      },
    });

    expect(out.agentName).toBe("codex");
    expect(out.model).toBe("gpt-5-codex");
    expect(out.agentConfig.model).toBe("gpt-5-codex");
  });

  it("prefers cli model over shared orchestratorModel when cli orchestratorModel is absent", () => {
    const out = resolveAgentSelection({
      role: "orchestrator",
      project: {
        ...baseProject,
        agentConfig: {
          orchestratorModel: "shared-orchestrator",
          model: "shared-model",
        },
        modelByCli: {
          "mock-agent": { model: "cli-model" },
        },
      },
      defaults: {
        runtime: "t",
        agent: "mock-agent",
        workspace: "w",
        notifiers: [],
      },
    });

    expect(out.model).toBe("cli-model");
    expect(out.agentConfig.model).toBe("cli-model");
  });
});
