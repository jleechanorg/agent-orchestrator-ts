/**
 * Unit tests for env-source.ts — sources shell init files and merges API-key
 * env vars into process.env without polluting PATH/PS1.
 *
 * Tests use the real sourceEnvFile/applyEnvSource exports via vi.mock.
 * SNAPSHOT_KEYS are deleted BEFORE vi.hoisted/vi.mock evaluation so that
 * ENV_BEFORE (captured at module import time) reflects the clean state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Delete ALLOWED_PREFIX vars BEFORE the hoisted mock and env-source import
// so that ENV_BEFORE captures them as undefined.
for (const k of [
  "MINIMAX_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MCP_AGENT_MAIL_URL",
  "MCP_AGENT_MAIL_TOKEN",
  "AO_CLI_PATH",
] as const) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- bootstrap clean env
  delete process.env[k];
}

// ---------------------------------------------------------------------------
// Hoisted mock functions — vi.hoisted runs before module imports, so we can
// control the mock state before sourceEnvFile/applyEnvSource are loaded.
// ---------------------------------------------------------------------------
const mockExecFileSync = vi.hoisted(() => vi.fn<typeof import("node:child_process").execFileSync>());
const mockExistsSync = vi.hoisted(() => vi.fn<typeof import("node:fs").existsSync>());

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

const { sourceEnvFile, applyEnvSource } = await import("../env-source.js");

/**
 * Replicate the ALLOWED_PREFIXES constant from env-source.ts so tests
 * can verify the correct set of prefixes is used.
 */
const ALLOWED_PREFIXES = [
  "MINIMAX_",
  "ANTHROPIC_",
  "OPENAI_",
  "MCP_AGENT_MAIL_",
  "AO_",
] as const;

/**
 * Mirror the parse logic from sourceEnvFile so we can test the parsing
 * contract in isolation from the execFileSync mock.
 */
function parseEnvOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex);
    const value = line.slice(eqIndex + 1);
    if (ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}

const SNAPSHOT_KEYS = [
  "MINIMAX_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MCP_AGENT_MAIL_URL",
  "MCP_AGENT_MAIL_TOKEN",
  "AO_CLI_PATH",
] as const;

function clearApiKeys() {
  for (const k of SNAPSHOT_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- legitimate use: typed literal key
    delete process.env[k];
  }
}

beforeEach(() => {
  clearApiKeys();
  mockExistsSync.mockReturnValue(true);
  mockExecFileSync.mockReturnValue(Buffer.from(""));
});
afterEach(() => clearApiKeys());

describe("sourceEnvFile — real exports", () => {
  it("returns MINIMAX_ vars from sourced output", () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from("MINIMAX_API_KEY=sk-cp-test\nHOME=/Users/test"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
  });

  it("returns ANTHROPIC_ vars", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("ANTHROPIC_API_KEY=sk-ant-test"));
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("returns OPENAI_ vars", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("OPENAI_API_KEY=sk-proj-openai"));
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty("OPENAI_API_KEY", "sk-proj-openai");
  });

  it("returns MCP_AGENT_MAIL_ vars", () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from("MCP_AGENT_MAIL_URL=https://mail.example.com"),
    );
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty(
      "MCP_AGENT_MAIL_URL",
      "https://mail.example.com",
    );
  });

  it("returns AO_ vars", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("AO_CLI_PATH=/usr/local/bin/ao"));
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty("AO_CLI_PATH", "/usr/local/bin/ao");
  });

  it("excludes PATH, HOME, and other system vars", () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from("PATH=/usr/bin:/bin\nHOME=/Users/test\nMINIMAX_API_KEY=sk-cp-test"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).not.toHaveProperty("PATH");
    expect(result).not.toHaveProperty("HOME");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
  });

  it("returns empty when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("returns empty when execFileSync throws", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("bash: source: file not found");
    });
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("calls execFileSync with bash -c source and -- separator", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("MINIMAX_API_KEY=sk-test"));
    sourceEnvFile("~/.bashrc");
    const lastCall = mockExecFileSync.mock.lastCall;
    expect(lastCall).not.toBeUndefined();
    const [cmd, args] = lastCall as [string, string[]];
    expect(cmd).toBe("bash");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toContain("source");
    expect(args).toContain("--");
  });

  // regression: `&&` silently drops vars if sourced file exits non-zero (e.g.
  // bashrc with `set -e` or a failing command at the end). `;` runs `env`
  // regardless of the sourced file's exit status.
  it("uses semicolon separator so env runs even when sourced file exits non-zero", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("MINIMAX_API_KEY=sk-cp-test"));
    sourceEnvFile("~/.bashrc");
    const lastCall = mockExecFileSync.mock.lastCall;
    const [, args] = lastCall as [string, string[]];
    const shellScript = args[args.indexOf("-c") + 1];
    // Must use `;` not `&&` so env runs even when source exits non-zero.
    expect(shellScript).toMatch(/^source "\$1" > \/dev\/null 2>&1; env$/);
    expect(shellScript).not.toMatch(/&&/);
  });
});

describe("parseEnvOutput — allowed prefixes (contract)", () => {
  it("includes MINIMAX_ vars", () => {
    const output = "MINIMAX_API_KEY=sk-cp-test\nHOME=/Users/test";
    expect(parseEnvOutput(output)).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
  });

  it("includes ANTHROPIC_ vars", () => {
    const output = "ANTHROPIC_API_KEY=sk-ant-test";
    expect(parseEnvOutput(output)).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("includes OPENAI_ vars", () => {
    const output = "OPENAI_API_KEY=sk-proj-openai";
    expect(parseEnvOutput(output)).toHaveProperty("OPENAI_API_KEY", "sk-proj-openai");
  });

  it("includes MCP_AGENT_MAIL_ vars", () => {
    const output = "MCP_AGENT_MAIL_URL=https://mail.example.com";
    expect(parseEnvOutput(output)).toHaveProperty("MCP_AGENT_MAIL_URL", "https://mail.example.com");
  });

  it("includes AO_ vars", () => {
    const output = "AO_CLI_PATH=/usr/local/bin/ao";
    expect(parseEnvOutput(output)).toHaveProperty("AO_CLI_PATH", "/usr/local/bin/ao");
  });

  it("excludes PATH, HOME, and other system vars", () => {
    const output = [
      "PATH=/usr/bin:/bin",
      "HOME=/Users/test",
      "USER=testuser",
      "SHELL=/bin/bash",
      "MINIMAX_API_KEY=sk-cp-test",
    ].join("\n");
    const result = parseEnvOutput(output);
    expect(result).not.toHaveProperty("PATH");
    expect(result).not.toHaveProperty("HOME");
    expect(result).not.toHaveProperty("USER");
    expect(result).not.toHaveProperty("SHELL");
    expect(result).toHaveProperty("MINIMAX_API_KEY");
  });

  it("handles empty output gracefully", () => {
    expect(parseEnvOutput("")).toEqual({});
    expect(parseEnvOutput("PATH=/bin\nHOME=/test")).toEqual({});
  });

  it("handles multiline output with mixed vars", () => {
    const output = [
      "HOME=/Users/test",
      "MINIMAX_API_KEY=sk-cp-1",
      "ANTHROPIC_API_KEY=sk-ant-1",
      "OPENAI_API_KEY=sk-openai-1",
      "MCP_AGENT_MAIL_URL=https://mail.example.com",
      "AO_CLI_PATH=/usr/local/bin/ao",
      "PAGER=less",
    ].join("\n");

    const result = parseEnvOutput(output);

    expect(result).toEqual({
      MINIMAX_API_KEY: "sk-cp-1",
      ANTHROPIC_API_KEY: "sk-ant-1",
      OPENAI_API_KEY: "sk-openai-1",
      MCP_AGENT_MAIL_URL: "https://mail.example.com",
      AO_CLI_PATH: "/usr/local/bin/ao",
    });
    expect(Object.keys(result)).toHaveLength(5);
  });
});

describe("applyEnvSource — real exports", () => {
  it("sets API keys in process.env from sourceEnvFile output", () => {
    mockExecFileSync.mockReturnValue(
      Buffer.from("MINIMAX_API_KEY=sk-cp-merged\nANTHROPIC_API_KEY=sk-ant-merged"),
    );
    applyEnvSource(["~/.bashrc"]);
    expect(process.env.MINIMAX_API_KEY).toBe("sk-cp-merged");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-merged");
  });

  it("does not set vars when sourceEnvFile returns empty", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("PATH=/usr/bin\nHOME=/test"));
    applyEnvSource(["~/.bashrc"]);
    expect(process.env.MINIMAX_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("handles multiple source files by merging into process.env", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("MINIMAX_API_KEY=sk-cp-first"))
      .mockReturnValueOnce(Buffer.from("ANTHROPIC_API_KEY=sk-ant-second"));
    applyEnvSource(["~/.bashrc", "~/.zshrc"]);
    expect(process.env.MINIMAX_API_KEY).toBe("sk-cp-first");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-second");
  });
});
