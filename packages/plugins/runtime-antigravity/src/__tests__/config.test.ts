import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  WorkspaceMapSchema,
  parseConfig,
  defaultConfig,
} from "../config.js";

// =============================================================================
// AntigravityConfigSchema & parseConfig
// =============================================================================

describe("parseConfig", () => {
  it("parses a valid full config and returns correct values", () => {
    const raw = {
      defaultModel: "Claude Sonnet 4",
      defaultMode: "Fast",
      pollIntervalMs: 30000,
      maxCapacityBackoffMs: 7200000,
      peekabooBin: "/usr/local/bin/peekaboo",
      fallbackCliBin: "/usr/local/bin/claude",
      fallbackCliFlags: ["--no-permissions"],
      fallbackMaxRetries: 5,
    };

    const config = parseConfig(raw);

    expect(config.defaultModel).toBe("Claude Sonnet 4");
    expect(config.defaultMode).toBe("Fast");
    expect(config.pollIntervalMs).toBe(30000);
    expect(config.maxCapacityBackoffMs).toBe(7200000);
    expect(config.peekabooBin).toBe("/usr/local/bin/peekaboo");
    expect(config.fallbackCliBin).toBe("/usr/local/bin/claude");
    expect(config.fallbackCliFlags).toEqual(["--no-permissions"]);
    expect(config.fallbackMaxRetries).toBe(5);
  });

  it("returns all defaults when given an empty object", () => {
    const config = parseConfig({});

    expect(config.defaultModel).toBe("Claude Opus 4.6");
    expect(config.defaultMode).toBe("Planning");
    expect(config.pollIntervalMs).toBe(15000);
    expect(config.maxCapacityBackoffMs).toBe(3600000);
    expect(config.peekabooBin).toBe("peekaboo");
    expect(config.fallbackCliBin).toBe("claude");
    expect(config.fallbackCliFlags).toEqual([
      "--dangerously-skip-permissions",
    ]);
    expect(config.fallbackMaxRetries).toBe(3);
  });

  it("throws ZodError when pollIntervalMs is below minimum (5000)", () => {
    expect(() => parseConfig({ pollIntervalMs: 1000 })).toThrow(ZodError);
  });

  it("throws ZodError when defaultMode is invalid", () => {
    expect(() => parseConfig({ defaultMode: "Turbo" })).toThrow(ZodError);
  });

  it("throws ZodError when fallbackMaxRetries is negative", () => {
    expect(() => parseConfig({ fallbackMaxRetries: -1 })).toThrow(ZodError);
  });
});

// =============================================================================
// defaultConfig
// =============================================================================

describe("defaultConfig", () => {
  it("returns all default values", () => {
    const config = defaultConfig();

    expect(config).toEqual({
      defaultModel: "Claude Opus 4.6",
      defaultMode: "Planning",
      pollIntervalMs: 15000,
      maxCapacityBackoffMs: 3600000,
      peekabooBin: "peekaboo",
      fallbackCliBin: "claude",
      fallbackCliFlags: ["--dangerously-skip-permissions"],
      fallbackMaxRetries: 3,
    });
  });
});

// =============================================================================
// WorkspaceMapSchema
// =============================================================================

describe("WorkspaceMapSchema", () => {
  it("parses a valid workspace map", () => {
    const raw = {
      "agent-orchestrator": {
        repoPath: "/Users/me/project/agent-orchestrator",
        workspaceName: "agent-orch",
        worktreeDir: "/tmp/worktrees",
      },
      "my-frontend": {
        repoPath: "/Users/me/project/frontend",
        workspaceName: "frontend-dev",
      },
    };

    const result = WorkspaceMapSchema.parse(raw);

    expect(result["agent-orchestrator"]?.repoPath).toBe(
      "/Users/me/project/agent-orchestrator",
    );
    expect(result["agent-orchestrator"]?.workspaceName).toBe("agent-orch");
    expect(result["agent-orchestrator"]?.worktreeDir).toBe("/tmp/worktrees");
    expect(result["my-frontend"]?.worktreeDir).toBeUndefined();
  });

  it("rejects entries missing required fields", () => {
    const raw = {
      bad: {
        repoPath: "/some/path",
        // missing workspaceName
      },
    };

    expect(() => WorkspaceMapSchema.parse(raw)).toThrow(ZodError);
  });

  it("parses an empty map", () => {
    const result = WorkspaceMapSchema.parse({});
    expect(result).toEqual({});
  });
});

// =============================================================================
// pollIntervalMs minimum enforcement
// =============================================================================

describe("pollIntervalMs minimum", () => {
  it("accepts exactly 5000", () => {
    const config = parseConfig({ pollIntervalMs: 5000 });
    expect(config.pollIntervalMs).toBe(5000);
  });

  it("rejects 4999", () => {
    expect(() => parseConfig({ pollIntervalMs: 4999 })).toThrow(ZodError);
  });
});
