import { describe, it, expect } from "vitest";
import {
  lookupCliModelDefaults,
  resolveAgentSelection,
  resolveSessionRole,
  resolveAgentSelectionForSession,
} from "../agent-selection.js";
import type { DefaultPlugins, ProjectConfig } from "../types.js";

/**
 * mini-default-smoke — minimal default-path smoke test.
 * Exercises the default agent-resolution pipeline without invoking any CLI or LLM.
 * If these tests pass, the canonical fallback chain
 * (`defaults.*` → `project.*` → `role.*`) is intact for both worker and
 * orchestrator sessions. Kept tiny and named so regressions in the default path
 * point reviewers straight here instead of into a 1.4k-line combined suite.
 */

const baseProject: ProjectConfig = {
  name: "demo",
  repo: "jleechanorg/demo",
  path: "/tmp/demo",
  defaultBranch: "main",
  sessionPrefix: "demo",
  agentConfig: {},
  orchestrator: {},
  worker: {},
};

const baseDefaults: DefaultPlugins = {
  runtime: "tmux",
  agent: "claude-code",
  workspace: "worktree",
  notifiers: [],
  agentConfig: { permissions: "default" },
};

describe("mini-default-smoke: worker path", () => {
  it("falls back to defaults.agent when project has no worker override", () => {
    const sel = resolveAgentSelection({ role: "worker", project: baseProject, defaults: baseDefaults });
    expect(sel.agentName).toBe("claude-code");
    expect(sel.role).toBe("worker");
  });

  it("project.worker.agent wins over defaults.agent", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: { ...baseProject, worker: { agent: "codex" } },
      defaults: baseDefaults,
    });
    expect(sel.agentName).toBe("codex");
  });

  it("project.worker.agent beats shared project.agent for worker", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: { ...baseProject, agent: "wafer", worker: { agent: "codex" } },
      defaults: baseDefaults,
    });
    expect(sel.agentName).toBe("codex");
  });

  it("project.agent (shared) wins over defaults.agent for worker", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: { ...baseProject, agent: "wafer" },
      defaults: baseDefaults,
    });
    expect(sel.agentName).toBe("wafer");
  });

  it("spawnAgentOverride wins over project and defaults for worker", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: { ...baseProject, agent: "wafer", worker: { agent: "codex" } },
      defaults: baseDefaults,
      spawnAgentOverride: "gemini",
    });
    expect(sel.agentName).toBe("gemini");
  });

  it("persistedAgent short-circuits the resolution chain", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: { ...baseProject, agent: "wafer" },
      defaults: baseDefaults,
      persistedAgent: "minimax",
    });
    expect(sel.agentName).toBe("minimax");
  });
});

describe("mini-default-smoke: orchestrator path", () => {
  it("falls back to defaults.agent when project has no orchestrator override", () => {
    const sel = resolveAgentSelection({ role: "orchestrator", project: baseProject, defaults: baseDefaults });
    expect(sel.agentName).toBe("claude-code");
    expect(sel.role).toBe("orchestrator");
  });

  it("project.orchestrator.agent wins over defaults.agent", () => {
    const sel = resolveAgentSelection({
      role: "orchestrator",
      project: { ...baseProject, orchestrator: { agent: "codex" } },
      defaults: baseDefaults,
    });
    expect(sel.agentName).toBe("codex");
  });

  it("project.orchestrator.agent beats shared project.agent for orchestrator", () => {
    const sel = resolveAgentSelection({
      role: "orchestrator",
      project: { ...baseProject, agent: "wafer", orchestrator: { agent: "codex" } },
      defaults: baseDefaults,
    });
    expect(sel.agentName).toBe("codex");
  });

  it("orchestrator resolves orchestratorModel when provided", () => {
    const sel = resolveAgentSelection({
      role: "orchestrator",
      project: baseProject,
      defaults: { ...baseDefaults, agentConfig: { orchestratorModel: "opus-orch" } },
    });
    expect(sel.model).toBe("opus-orch");
    expect(sel.agentConfig.model).toBe("opus-orch");
  });
});

describe("mini-default-smoke: model resolution (no CLI invocation)", () => {
  it("modelByCli lookup is pure and case-insensitive", () => {
    const out = lookupCliModelDefaults({ "Claude-Code": { model: "sonnet" } }, "claude-code");
    expect(out.model).toBe("sonnet");
  });

  it("worker model resolves from defaults.modelByCli for the chosen agent", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: baseProject,
      defaults: { ...baseDefaults, modelByCli: { "claude-code": { model: "smoke-worker-model" } } },
    });
    expect(sel.model).toBe("smoke-worker-model");
    expect(sel.agentConfig.model).toBe("smoke-worker-model");
  });

  it("orchestrator model prefers orchestratorModel over model in modelByCli", () => {
    const sel = resolveAgentSelection({
      role: "orchestrator",
      project: baseProject,
      defaults: {
        ...baseDefaults,
        modelByCli: { "claude-code": { model: "worker-fallback", orchestratorModel: "smoke-orch-model" } },
      },
    });
    expect(sel.model).toBe("smoke-orch-model");
  });

  it("no model is set when neither agentConfig nor modelByCli provides one", () => {
    const sel = resolveAgentSelection({
      role: "worker",
      project: baseProject,
      defaults: { ...baseDefaults, agentConfig: {} },
    });
    expect(sel.model).toBeUndefined();
    expect(sel.agentConfig.model).toBeUndefined();
  });
});

describe("mini-default-smoke: session role resolution", () => {
  it("treats exact project orchestrator id as orchestrator", () => {
    expect(resolveSessionRole("demo-orchestrator", undefined, "demo", ["demo"])).toBe("orchestrator");
  });

  it("treats any other id as worker", () => {
    expect(resolveSessionRole("demo-worker-1", undefined, "demo", ["demo"])).toBe("worker");
  });
});

describe("mini-default-smoke: end-to-end session wiring", () => {
  it("resolveAgentSelectionForSession forwards persistedAgent metadata to selection", () => {
    const sel = resolveAgentSelectionForSession({
      sessionId: "demo-orchestrator",
      project: baseProject,
      defaults: baseDefaults,
      metadata: { agent: "minimax" },
    });
    expect(sel.role).toBe("orchestrator");
    expect(sel.agentName).toBe("minimax");
  });

  it("resolveAgentSelectionForSession defaults to defaults.agent for plain worker", () => {
    const sel = resolveAgentSelectionForSession({
      sessionId: "demo-worker-99",
      project: baseProject,
      defaults: baseDefaults,
    });
    expect(sel.role).toBe("worker");
    expect(sel.agentName).toBe("claude-code");
  });
});