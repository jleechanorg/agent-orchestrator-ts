import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  process.env["CLAUDE_BINARY"] = "/mock/claude";
});

vi.mock("node:child_process", async () => {
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...original,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("node:fs", async () => {
  const original = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...original,
    accessSync: mockAccessSync,
    constants: { ...original.constants, X_OK: 1 },
  };
});

vi.mock("@jleechanorg/ao-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@jleechanorg/ao-core")>();
  return {
    ...original,
    loadConfig: mockLoadConfig,
  };
});

import { tryClaudePrint } from "../../src/lib/llm-eval.js";

describe("llm-eval-shared propagation test", () => {
  let originalBaseUrl: string | undefined;
  let originalAuthToken: string | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn<typeof console, "debug">>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    mockAccessSync.mockReset();
    mockLoadConfig.mockReset();

    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/claude" || path === "claude") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    mockExecFileSync.mockReturnValue("VERDICT: PASS");

    originalBaseUrl = process.env["ANTHROPIC_BASE_URL"];
    originalAuthToken = process.env["ANTHROPIC_AUTH_TOKEN"];
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalBaseUrl !== undefined) {
      process.env["ANTHROPIC_BASE_URL"] = originalBaseUrl;
    } else {
      delete process.env["ANTHROPIC_BASE_URL"];
    }
    if (originalAuthToken !== undefined) {
      process.env["ANTHROPIC_AUTH_TOKEN"] = originalAuthToken;
    } else {
      delete process.env["ANTHROPIC_AUTH_TOKEN"];
    }
    consoleDebugSpy.mockRestore();
  });

  it("does not propagate ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN by default (when active agent is default claude-code and no useShellEnv)", async () => {
    mockLoadConfig.mockReturnValue({
      defaults: { agent: "claude-code" },
      plugins: {},
      projects: {},
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    await tryClaudePrint("evaluate this");

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
    const callArgs = mockExecFileSync.mock.calls[0];
    const options = callArgs[2];
    expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(consoleDebugSpy).not.toHaveBeenCalled();
  });

  it("propagates ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN and logs debug if useShellEnv is true in config", async () => {
    mockLoadConfig.mockReturnValue({
      defaults: { agent: "claude-code" },
      plugins: {
        "claude-code": {
          useShellEnv: true,
        },
      },
      projects: {},
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    await tryClaudePrint("evaluate this");

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
    const callArgs = mockExecFileSync.mock.calls[0];
    const options = callArgs[2];
    expect(options.env.ANTHROPIC_BASE_URL).toBe("https://pass.wafer.ai");
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-fake");
    expect(consoleDebugSpy).toHaveBeenCalled();
    const debugCalls = consoleDebugSpy.mock.calls.map((c) => c[0] as string);
    expect(debugCalls.some((c: string) => c.includes("Reading ANTHROPIC_BASE_URL"))).toBe(true);
    expect(debugCalls.some((c: string) => c.includes("Reading ANTHROPIC_AUTH_TOKEN"))).toBe(true);
  });

  it("propagates ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN and logs debug if the active agent is a provider plugin like wafer", async () => {
    mockLoadConfig.mockReturnValue({
      defaults: { agent: "wafer" },
      plugins: {},
      projects: {},
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    await tryClaudePrint("evaluate this");

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
    const callArgs = mockExecFileSync.mock.calls[0];
    const options = callArgs[2];
    expect(options.env.ANTHROPIC_BASE_URL).toBe("https://pass.wafer.ai");
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-fake");
    expect(consoleDebugSpy).toHaveBeenCalled();
    const debugCalls = consoleDebugSpy.mock.calls.map((c) => c[0] as string);
    expect(debugCalls.some((c: string) => c.includes("active agent is provider plugin"))).toBe(true);
  });

  it("propagates ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN and logs debug if the active agent is a provider plugin like minimax", async () => {
    mockLoadConfig.mockReturnValue({
      defaults: { agent: "minimax" },
      plugins: {},
      projects: {},
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    await tryClaudePrint("evaluate this");

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
    const callArgs = mockExecFileSync.mock.calls[0];
    const options = callArgs[2];
    expect(options.env.ANTHROPIC_BASE_URL).toBe("https://pass.wafer.ai");
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-fake");
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  it("propagates ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN and logs debug if the active agent is a provider plugin like agy", async () => {
    mockLoadConfig.mockReturnValue({
      defaults: { agent: "agy" },
      plugins: {},
      projects: {},
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    await tryClaudePrint("evaluate this");

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalled();
    const callArgs = mockExecFileSync.mock.calls[0];
    const options = callArgs[2];
    expect(options.env.ANTHROPIC_BASE_URL).toBe("https://pass.wafer.ai");
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-fake");
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  it("resolves project-specific agent from CWD and config projects", async () => {
    const originalCwd = process.cwd;
    const configPath = path.resolve("/mock/config.yaml");
    const configDir = path.dirname(configPath);
    const resolvedSubPath = path.resolve(configDir, "./project/path/sub");

    process.cwd = () => resolvedSubPath;

    mockLoadConfig.mockReturnValue({
      configPath,
      defaults: { agent: "claude-code" },
      plugins: {},
      projects: {
        "my-project": {
          path: "./project/path",
          agent: "wafer",
        },
      },
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    try {
      await tryClaudePrint("evaluate this");

      expect(mockLoadConfig).toHaveBeenCalled();
      expect(mockExecFileSync).toHaveBeenCalled();
      const callArgs = mockExecFileSync.mock.calls[0];
      const options = callArgs[2];
      expect(options.env.ANTHROPIC_BASE_URL).toBe("https://pass.wafer.ai");
      expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-fake");
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("resolves project-specific agent from nested projects sorted by path specificity", async () => {
    const originalCwd = process.cwd;
    const configPath = path.resolve("/mock/config.yaml");
    const configDir = path.dirname(configPath);
    const resolvedSubPath = path.resolve(configDir, "./project/path/sub");

    process.cwd = () => resolvedSubPath;

    mockLoadConfig.mockReturnValue({
      configPath,
      defaults: { agent: "claude-code" },
      plugins: {},
      projects: {
        "parent-project": {
          path: "./project/path",
          agent: "claude-code",
        },
        "child-project": {
          path: "./project/path/sub",
          agent: "wafer",
        },
      },
    });

    process.env["ANTHROPIC_BASE_URL"] = "https://pass.wafer.ai";
    process.env["ANTHROPIC_AUTH_TOKEN"] = "sk-fake";

    try {
      await tryClaudePrint("evaluate this");

      expect(mockLoadConfig).toHaveBeenCalled();
      expect(mockExecFileSync).toHaveBeenCalled();
      const callArgs = mockExecFileSync.mock.calls[0];
      const options = callArgs[2];
      expect(options.env.ANTHROPIC_BASE_URL).toBe("https://pass.wafer.ai");
      expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-fake");
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe("isAuthError fallback patterns", () => {
  it("treats Claude 'Not logged in · Please run /login' as auth failure", async () => {
    const { isAuthError } = await import("../../src/lib/llm-eval-shared.js");
    expect(isAuthError("Not logged in · Please run /login")).toBe(true);
    expect(isAuthError("not logged in")).toBe(true);
    expect(isAuthError("please run /login first")).toBe(true);
  });

  it("treats Codex-style quota/review-limit messages as auth failure", async () => {
    const { isAuthError } = await import("../../src/lib/llm-eval-shared.js");
    expect(isAuthError("You have reached your Codex usage limits for code reviews.")).toBe(true);
    expect(isAuthError("Review limit reached")).toBe(true);
    expect(isAuthError("rate limit reached")).toBe(true);
  });

  it("still matches existing 401/403/unauthorized/forbidden patterns", async () => {
    const { isAuthError } = await import("../../src/lib/llm-eval-shared.js");
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("403 Forbidden")).toBe(true);
    expect(isAuthError("Authentication required: unauthorized")).toBe(true);
    expect(isAuthError("Access denied: forbidden")).toBe(true);
  });

  it("does not match unrelated error strings", async () => {
    const { isAuthError } = await import("../../src/lib/llm-eval-shared.js");
    expect(isAuthError("Network timeout")).toBe(false);
    expect(isAuthError("Invalid prompt: missing VERDICT line")).toBe(false);
    expect(isAuthError("Server error 500")).toBe(false);
  });
});

describe("isUnavailable fallback patterns", () => {
  it("treats Codex CLI config-load errors as unavailable", async () => {
    const { isUnavailable } = await import("../../src/lib/llm-eval-shared.js");
    expect(isUnavailable("Error loading config.toml: unknown variant default")).toBe(true);
  });

  it("treats Claude 'Not logged in' as unavailable (falls through to next model)", async () => {
    const { isUnavailable } = await import("../../src/lib/llm-eval-shared.js");
    expect(isUnavailable("Not logged in · Please run /login")).toBe(true);
  });

  it("treats Codex-style quota messages as unavailable", async () => {
    const { isUnavailable } = await import("../../src/lib/llm-eval-shared.js");
    expect(isUnavailable("Codex CLI: usage limits reached")).toBe(true);
  });
});
