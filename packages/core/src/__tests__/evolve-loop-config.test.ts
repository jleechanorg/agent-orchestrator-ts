/**
 * Unit tests for EvolveLoopConfig — types, config schema, and prompt injection.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateConfig } from "../config.js";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { EvolveLoopConfig, OrchestratorConfig, ProjectConfig } from "../types.js";

// --- types.test.ts equivalent for EvolveLoopConfig ---

describe("EvolveLoopConfig type", () => {
  it("has all required fields typed correctly", () => {
    const config: EvolveLoopConfig = {
      enabled: true,
      pollCadence: "standard",
      autonomousFixScopes: ["config-edit", "claw-dispatch"],
      blockedScopes: ["bead-delete"],
      knowledgeBaseDir: "~/.ao-evolve-knowledge",
      zeroTouchWindow: "24h",
    };

    expect(config.enabled).toBe(true);
    expect(config.pollCadence).toBe("standard");
    expect(config.autonomousFixScopes).toContain("claw-dispatch");
    expect(config.blockedScopes).toContain("bead-delete");
    expect(config.knowledgeBaseDir).toBe("~/.ao-evolve-knowledge");
    expect(config.zeroTouchWindow).toBe("24h");
  });

  it("all fields are optional", () => {
    const config: EvolveLoopConfig = {};
    expect(config.enabled).toBeUndefined();
    expect(config.pollCadence).toBeUndefined();
    expect(config.autonomousFixScopes).toBeUndefined();
    expect(config.blockedScopes).toBeUndefined();
    expect(config.knowledgeBaseDir).toBeUndefined();
    expect(config.zeroTouchWindow).toBeUndefined();
  });

  it("pollCadence accepts 'lightweight' or 'standard'", () => {
    const lightweight: EvolveLoopConfig = { pollCadence: "lightweight" };
    const standard: EvolveLoopConfig = { pollCadence: "standard" };
    expect(lightweight.pollCadence).toBe("lightweight");
    expect(standard.pollCadence).toBe("standard");
  });

  it("zeroTouchWindow accepts '24h' or '30d'", () => {
    const window24h: EvolveLoopConfig = { zeroTouchWindow: "24h" };
    const window30d: EvolveLoopConfig = { zeroTouchWindow: "30d" };
    expect(window24h.zeroTouchWindow).toBe("24h");
    expect(window30d.zeroTouchWindow).toBe("30d");
  });
});

// --- config.test.ts equivalent for evolveLoop Zod schema ---

const minimalConfig = {
  projects: {
    proj1: {
      path: "/repos/test",
      repo: "org/test",
      defaultBranch: "main",
    },
  },
};

describe("Config Schema — evolveLoop", () => {
  it("accepts evolveLoop with all fields", () => {
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: {
            enabled: true,
            pollCadence: "standard",
            autonomousFixScopes: ["config-edit", "claw-dispatch", "bead-create"],
            blockedScopes: ["bead-delete"],
            knowledgeBaseDir: "~/.ao-evolve",
            zeroTouchWindow: "24h",
          },
        },
      },
    });

    const evolveLoop = validated.projects.proj1.evolveLoop;
    expect(evolveLoop?.enabled).toBe(true);
    expect(evolveLoop?.pollCadence).toBe("standard");
    expect(evolveLoop?.autonomousFixScopes).toEqual([
      "config-edit",
      "claw-dispatch",
      "bead-create",
    ]);
    expect(evolveLoop?.blockedScopes).toEqual(["bead-delete"]);
    // knowledgeBaseDir is expanded: ~ is replaced with the OS home directory
    // Check platform-agnostically: no leading ~, ends with the directory name
    expect(evolveLoop?.knowledgeBaseDir).not.toMatch(/^~/);
    expect(evolveLoop?.knowledgeBaseDir).toMatch(/\.ao-evolve$/);
    expect(evolveLoop?.zeroTouchWindow).toBe("24h");
  });

  it("accepts evolveLoop with no fields (all optional)", () => {
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: {},
        },
      },
    });

    expect(validated.projects.proj1.evolveLoop).toBeDefined();
    expect(validated.projects.proj1.evolveLoop?.enabled).toBeUndefined();
  });

  it("accepts evolveLoop without evolveLoop field (omitted is fine)", () => {
    const validated = validateConfig(minimalConfig);
    expect(validated.projects.proj1.evolveLoop).toBeUndefined();
  });

  it("applies default pollCadence = 'lightweight' when enabled=true but pollCadence omitted", () => {
    // When enabled=true, pollCadence should default to 'lightweight' via the Zod schema
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: { enabled: true },
        },
      },
    });

    expect(validated.projects.proj1.evolveLoop?.pollCadence).toBe("lightweight");
  });

  it("applies default autonomousFixScopes = []", () => {
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: { enabled: true },
        },
      },
    });

    expect(validated.projects.proj1.evolveLoop?.autonomousFixScopes).toEqual([]);
  });

  it("applies default blockedScopes = []", () => {
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: { enabled: true },
        },
      },
    });

    expect(validated.projects.proj1.evolveLoop?.blockedScopes).toEqual([]);
  });

  it("applies default zeroTouchWindow = '24h'", () => {
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: { enabled: true },
        },
      },
    });

    expect(validated.projects.proj1.evolveLoop?.zeroTouchWindow).toBe("24h");
  });

  it("EVOLVE_LOOP_ENABLED=false disables evolveLoop via explicit string check", () => {
    // Use explicit string comparison — z.coerce.boolean() would treat 'false' as true
    const original = process.env["EVOLVE_LOOP_ENABLED"];
    process.env["EVOLVE_LOOP_ENABLED"] = "false";

    try {
      const validated = validateConfig({
        ...minimalConfig,
        projects: {
          proj1: {
            ...minimalConfig.projects.proj1,
            evolveLoop: { enabled: true },
          },
        },
      });

      // Explicit "false" string → disabled regardless of config
      expect(validated.projects.proj1.evolveLoop?.enabled).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env["EVOLVE_LOOP_ENABLED"] = original;
      } else {
        delete process.env["EVOLVE_LOOP_ENABLED"];
      }
    }
  });

  it("knowledgeBaseDir '~/.foo' expands ~ correctly using os.homedir()", () => {
    const validated = validateConfig({
      ...minimalConfig,
      projects: {
        proj1: {
          ...minimalConfig.projects.proj1,
          evolveLoop: {
            enabled: true,
            knowledgeBaseDir: "~/.ao-evolve-knowledge",
          },
        },
      },
    });

    const kbDir = validated.projects.proj1.evolveLoop?.knowledgeBaseDir;
    // Should NOT start with '~' — must be expanded to an absolute path
    expect(kbDir).not.toMatch(/^~/);
    // Should contain the expected directory name
    expect(kbDir).toContain(".ao-evolve-knowledge");
  });

  it("rejects invalid pollCadence", () => {
    expect(() =>
      validateConfig({
        ...minimalConfig,
        projects: {
          proj1: {
            ...minimalConfig.projects.proj1,
            evolveLoop: { pollCadence: "fast" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects invalid zeroTouchWindow", () => {
    expect(() =>
      validateConfig({
        ...minimalConfig,
        projects: {
          proj1: {
            ...minimalConfig.projects.proj1,
            evolveLoop: { zeroTouchWindow: "7d" },
          },
        },
      }),
    ).toThrow();
  });

  it("EVOLVE_LOOP_ENABLED=false env var disables evolveLoop", () => {
    const original = process.env["EVOLVE_LOOP_ENABLED"];
    process.env["EVOLVE_LOOP_ENABLED"] = "false";

    try {
      const validated = validateConfig({
        ...minimalConfig,
        projects: {
          proj1: {
            ...minimalConfig.projects.proj1,
            evolveLoop: { enabled: true },
          },
        },
      });

      // When env var is false, the enabled flag is coerced to false
      expect(validated.projects.proj1.evolveLoop?.enabled).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env["EVOLVE_LOOP_ENABLED"] = original;
      } else {
        delete process.env["EVOLVE_LOOP_ENABLED"];
      }
    }
  });
});

// --- orchestrator-prompt.test.ts equivalent for generateEvolveLoopSection ---

function makeConfig(overrides: Partial<ProjectConfig> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      proj1: {
        name: "Test Project",
        repo: "org/test",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
        ...overrides,
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 120_000,
  };
}

describe("generateEvolveLoopSection — enabled", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["EVOLVE_LOOP_ENABLED"];
  });

  it("includes evolve loop section when evolveLoop.enabled=true", () => {
    const config = makeConfig({
      evolveLoop: { enabled: true },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("## Evolve Loop");
    expect(prompt).toContain("OBSERVE");
    expect(prompt).toContain("MEASURE");
    expect(prompt).toContain("DIAGNOSE");
    expect(prompt).toContain("PLAN");
    expect(prompt).toContain("FIX");
    expect(prompt).toContain("RECORD");
  });

  it("includes all 8 phases in evolve loop section", () => {
    const config = makeConfig({
      evolveLoop: { enabled: true },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    // All phases should appear
    expect(prompt).toContain("### Phase 1: OBSERVE");
    expect(prompt).toContain("### Phase 2: MEASURE");
    expect(prompt).toContain("### Phase 3: DIAGNOSE");
    expect(prompt).toContain("### Phase 4: PLAN");
    expect(prompt).toContain("### Phase 5: FIX");
    expect(prompt).toContain("### Phase 6: RECORD");
    expect(prompt).toContain("### Phase 7: RECAP");
    expect(prompt).toContain("### Phase 8: AUTO-CANCEL");
  });

  it("includes Phase 7 recap section with key summary elements", () => {
    const config = makeConfig({
      evolveLoop: { enabled: true },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("### Phase 7: RECAP");
    expect(prompt).toContain("Summary: zero-touch rate");
    expect(prompt).toContain("Worker count");
    expect(prompt).toContain("Open PRs");
    expect(prompt).toContain("friction");
    expect(prompt).toContain("Fixes dispatched");
    expect(prompt).toContain("Beads");
  });

  it("includes Phase 8 auto-cancel section with idle counter and cancel language", () => {
    const config = makeConfig({
      evolveLoop: { enabled: true },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("### Phase 8: AUTO-CANCEL");
    expect(prompt).toContain("Idle-cycle counter");
    expect(prompt).toContain("idle-counter");
    expect(prompt).toContain("3 consecutive idle cycles");
    expect(prompt).toContain("AUTO-CANCEL: 3 consecutive idle cycles — eloop pausing");
  });

  it("lists autonomousFixScopes allow-list in FIX phase", () => {
    const config = makeConfig({
      evolveLoop: {
        enabled: true,
        autonomousFixScopes: ["config-edit", "claw-dispatch", "bead-create"],
      },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("config-edit");
    expect(prompt).toContain("claw-dispatch");
    expect(prompt).toContain("bead-create");
  });

  it("lists blockedScopes deny-list in FIX phase", () => {
    const config = makeConfig({
      evolveLoop: {
        enabled: true,
        blockedScopes: ["bead-delete"],
      },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("bead-delete");
  });

  it("includes implicit deny-list (always blocked)", () => {
    const config = makeConfig({
      evolveLoop: { enabled: true },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    // These are always blocked regardless of config
    expect(prompt).toContain("gh pr merge");
    expect(prompt).toContain("gh pr close");
    expect(prompt).toContain("git reset --hard");
    expect(prompt).toContain("git clean -fd");
    expect(prompt).toContain("git worktree remove");
    expect(prompt).toContain("rm -rf");
  });

  it("mentions zeroTouchWindow setting", () => {
    const config = makeConfig({
      evolveLoop: {
        enabled: true,
        zeroTouchWindow: "30d",
      },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("30d");
    expect(prompt).toContain("zero-touch");
  });

  it("defaults zeroTouchWindow to 24h", () => {
    const config = makeConfig({
      evolveLoop: { enabled: true },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).toContain("24h");
  });

  it("skips FIX phase autonomousFixScopes when allow-list is empty", () => {
    const config = makeConfig({
      evolveLoop: {
        enabled: true,
        autonomousFixScopes: [],
      },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    // When allow-list is empty, manager should note this
    expect(prompt).toContain("read-only mode");
    // config-edit may appear in the "Always blocked" section but not as an allowed scope
    // The FIX phase should NOT have a list of allowed scopes
    expect(prompt).not.toContain("claw-dispatch"); // neither scope appears as allowed
  });
});

describe("generateEvolveLoopSection — disabled", () => {
  beforeEach(() => {
    delete process.env["EVOLVE_LOOP_ENABLED"];
  });

  it("omits evolve loop section when evolveLoop.enabled=false", () => {
    const config = makeConfig({
      evolveLoop: { enabled: false },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).not.toContain("## Evolve Loop");
    expect(prompt).not.toContain("OBSERVE");
    expect(prompt).not.toContain("MEASURE");
  });

  it("omits evolve loop section when evolveLoop is absent", () => {
    const config = makeConfig({});

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    expect(prompt).not.toContain("## Evolve Loop");
    expect(prompt).not.toContain("OBSERVE");
    expect(prompt).not.toContain("MEASURE");
  });

  it("omits evolve loop section when EVOLVE_LOOP_ENABLED=false env var", () => {
    const original = process.env["EVOLVE_LOOP_ENABLED"];
    process.env["EVOLVE_LOOP_ENABLED"] = "false";

    try {
      vi.resetModules();

      const config = makeConfig({
        evolveLoop: { enabled: true },
      });

      const prompt = generateOrchestratorPrompt({
        config,
        projectId: "proj1",
        project: config.projects.proj1,
      });

      expect(prompt).not.toContain("## Evolve Loop");
    } finally {
      if (original !== undefined) {
        process.env["EVOLVE_LOOP_ENABLED"] = original;
      } else {
        delete process.env["EVOLVE_LOOP_ENABLED"];
      }
    }
  });
});

describe("generateEvolveLoopSection — autonomousFixScopes allow-list", () => {
  it("only mentions explicitly allowed scopes in FIX phase", () => {
    const config = makeConfig({
      evolveLoop: {
        enabled: true,
        autonomousFixScopes: ["claw-dispatch"],
      },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    // The allowed scope should appear in the "Allowed dispatch scopes" section
    expect(prompt).toContain("claw-dispatch");
    // A scope NOT in the allow-list should not appear as "Allowed dispatch scopes"
    // The FIX phase "Allowed dispatch scopes" section should contain only the allow-list
    const fixSectionMatch = prompt.match(/\*\*Allowed dispatch scopes\*\*.*?Dispatch methods:/s);
    expect(fixSectionMatch?.[0]).toContain("claw-dispatch");
    expect(fixSectionMatch?.[0]).not.toContain("config-edit");
  });

  it("implicit deny-list always blocks dangerous commands even if not in blockedScopes", () => {
    const config = makeConfig({
      evolveLoop: {
        enabled: true,
        blockedScopes: [], // explicit blockedScopes is empty
      },
    });

    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "proj1",
      project: config.projects.proj1,
    });

    // But implicit deny-list commands should still appear as always-blocked
    expect(prompt).toContain("gh pr merge");
    expect(prompt).toContain("git reset --hard");
    expect(prompt).toContain("rm -rf");
  });
});
