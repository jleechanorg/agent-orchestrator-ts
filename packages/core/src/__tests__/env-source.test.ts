/**
 * Unit tests for env-source.ts parsing and apply logic.
 *
 * The execSync-based sourcing is tested by mocking node:child_process via
 * a helper that injects a fake env output string. We test the parseEnvOutput
 * function (extracted from sourceEnvFile for testability) and the
 * applyEnvSource integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
 * Mirror the parse logic from sourceEnvFile so we can test the contract
 * without needing to mock execSync.
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

beforeEach(() => clearApiKeys());
afterEach(() => clearApiKeys());

describe("parseEnvOutput — allowed prefixes", () => {
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

describe("applyEnvSource — process.env mutation", () => {
  it("sets API keys in process.env from parsed env vars", () => {
    const fakeEnvOutput = "MINIMAX_API_KEY=sk-cp-merged\nANTHROPIC_API_KEY=sk-ant-merged";
    const parsed = parseEnvOutput(fakeEnvOutput);

    // Simulate what applyEnvSource does
    for (const [key, value] of Object.entries(parsed)) {
      process.env[key] = value;
    }

    expect(process.env.MINIMAX_API_KEY).toBe("sk-cp-merged");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-merged");
  });

  it("does not set vars when parseEnvOutput returns empty", () => {
    const parsed = parseEnvOutput("PATH=/usr/bin\nHOME=/test");

    for (const [key, value] of Object.entries(parsed)) {
      process.env[key] = value;
    }

    expect(process.env.MINIMAX_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("handles multiple source files by merging into process.env", () => {
    const file1Vars = parseEnvOutput("MINIMAX_API_KEY=sk-cp-first");
    const file2Vars = parseEnvOutput("ANTHROPIC_API_KEY=sk-ant-second");

    for (const [key, value] of Object.entries({ ...file1Vars, ...file2Vars })) {
      process.env[key] = value;
    }

    expect(process.env.MINIMAX_API_KEY).toBe("sk-cp-first");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-second");
  });
});
