/**
 * Unit tests for env-source.ts — sources shell init files and merges env vars
 * into process.env, blocking dangerous system/shell-injection vars.
 *
 * Tests use the real sourceEnvFile/applyEnvSource exports via vi.mock.
 * SNAPSHOT_KEYS are deleted BEFORE vi.hoisted/vi.mock evaluation so that
 * ENV_BEFORE (captured at module import time) reflects the clean state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";

// Delete API-key vars BEFORE the hoisted mock and env-source import
// so that ENV_BEFORE captures them as undefined.
for (const k of [
  "MINIMAX_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MCP_AGENT_MAIL_URL",
  "MCP_AGENT_MAIL_TOKEN",
  "AO_CLI_PATH",
] as const) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- JSDOM requires explicit delete to remove keys; undefined assignment converts to "undefined" string
    delete process.env[k];
}

// ---------------------------------------------------------------------------
// Hoisted mock functions — vi.hoisted runs before module imports, so we can
// control the mock state before sourceEnvFile/applyEnvSource are loaded.
// ---------------------------------------------------------------------------
const mockSpawnSync = vi.hoisted(() => vi.fn<typeof import("node:child_process").spawnSync>());
const mockExistsSync = vi.hoisted(() => vi.fn<typeof import("node:fs").existsSync>());
const mockReadFileSync = vi.hoisted(() => vi.fn<typeof import("node:fs").readFileSync>());

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

const { sourceEnvFile, applyEnvSource, isBlocked } = await import("../env-source.js");

/**
 * Mirror the parse logic from sourceEnvFile so we can test the parsing
 * contract in isolation from the spawnSync mock.
 */
function parseEnvOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex);
    const value = line.slice(eqIndex + 1);
    if (!isBlocked(key)) {
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
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- JSDOM requires explicit delete to remove keys; undefined assignment converts to "undefined" string
    delete process.env[k];
  }
}

function setSpawnSuccess(stdout: string | Buffer) {
  const buf = typeof stdout === "string" ? Buffer.from(stdout) : stdout;
  mockSpawnSync.mockReturnValue({
    pid: 1,
    output: [null, buf, Buffer.from("")],
    stdout: buf,
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    error: undefined,
  } satisfies SpawnSyncReturns<Buffer>);
}

beforeEach(() => {
  clearApiKeys();
  mockExistsSync.mockReturnValue(true);
  setSpawnSuccess(Buffer.from(""));
});
afterEach(() => clearApiKeys());

describe("isBlocked — blocklist contract", () => {
  it("blocks PATH", () => {
    expect(isBlocked("PATH")).toBe(true);
  });

  it("blocks HOME", () => {
    expect(isBlocked("HOME")).toBe(true);
  });

  it("blocks SHELL", () => {
    expect(isBlocked("SHELL")).toBe(true);
  });

  it("blocks BASH_ENV (shell injection)", () => {
    expect(isBlocked("BASH_ENV")).toBe(true);
  });

  it("blocks ENV (POSIX equivalent of BASH_ENV)", () => {
    expect(isBlocked("ENV")).toBe(true);
  });

  it("blocks PWD and OLDPWD (cwd pollution from sourced bashrc)", () => {
    expect(isBlocked("PWD")).toBe(true);
    expect(isBlocked("OLDPWD")).toBe(true);
  });

  it("blocks BASH_FUNC_ prefix (shell function injection)", () => {
    expect(isBlocked("BASH_FUNC_foo%%")).toBe(true);
  });

  it("allows HOMEBREW_PREFIX (must not treat HOME as a prefix)", () => {
    expect(isBlocked("HOMEBREW_PREFIX")).toBe(false);
  });

  it("blocks NODE_OPTIONS (Node injection)", () => {
    expect(isBlocked("NODE_OPTIONS")).toBe(true);
  });

  it("blocks LD_PRELOAD (shared-lib injection)", () => {
    expect(isBlocked("LD_PRELOAD")).toBe(true);
  });

  it("blocks DYLD_INSERT_LIBRARIES (macOS shared-lib injection)", () => {
    expect(isBlocked("DYLD_INSERT_LIBRARIES")).toBe(true);
  });

  it("blocks PS1 (prompt)", () => {
    expect(isBlocked("PS1")).toBe(true);
  });

  it("blocks XDG_ prefix", () => {
    expect(isBlocked("XDG_CONFIG_HOME")).toBe(true);
  });

  it("allows MINIMAX_API_KEY", () => {
    expect(isBlocked("MINIMAX_API_KEY")).toBe(false);
  });

  it("allows ANTHROPIC_API_KEY", () => {
    expect(isBlocked("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("allows custom MY_APP_CONFIG", () => {
    expect(isBlocked("MY_APP_CONFIG")).toBe(false);
  });
});

describe("sourceEnvFile — real exports", () => {
  it("returns MINIMAX_ vars from sourced output", () => {
    setSpawnSuccess(
      Buffer.from("MINIMAX_API_KEY=sk-cp-test\nHOME=/Users/test"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
  });

  it("returns ANTHROPIC_ vars", () => {
    setSpawnSuccess(Buffer.from("ANTHROPIC_API_KEY=sk-ant-test"));
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("returns OPENAI_ vars", () => {
    setSpawnSuccess(Buffer.from("OPENAI_API_KEY=sk-proj-openai"));
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty("OPENAI_API_KEY", "sk-proj-openai");
  });

  it("returns MCP_AGENT_MAIL_ vars", () => {
    setSpawnSuccess(
      Buffer.from("MCP_AGENT_MAIL_URL=https://mail.example.com"),
    );
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty(
      "MCP_AGENT_MAIL_URL",
      "https://mail.example.com",
    );
  });

  it("returns AO_ vars", () => {
    setSpawnSuccess(Buffer.from("AO_CLI_PATH=/usr/local/bin/ao"));
    expect(sourceEnvFile("~/.bashrc")).toHaveProperty("AO_CLI_PATH", "/usr/local/bin/ao");
  });

  it("excludes PATH, HOME, and other blocked vars", () => {
    setSpawnSuccess(
      Buffer.from("PATH=/usr/bin:/bin\nHOME=/Users/test\nMINIMAX_API_KEY=sk-cp-test"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).not.toHaveProperty("PATH");
    expect(result).not.toHaveProperty("HOME");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
  });

  it("excludes BASH_ENV (shell injection)", () => {
    setSpawnSuccess(
      Buffer.from("BASH_ENV=/tmp/malicious.sh\nMINIMAX_API_KEY=sk-cp-test"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).not.toHaveProperty("BASH_ENV");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
  });

  it("excludes BASH_FUNC_ vars (shell function injection)", () => {
    setSpawnSuccess(
      Buffer.from("BASH_FUNC_foo%%=() { echo pwned }\nANTHROPIC_API_KEY=sk-ant-test"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).not.toHaveProperty("BASH_FUNC_foo%%");
    expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("excludes NODE_OPTIONS (Node injection)", () => {
    setSpawnSuccess(
      Buffer.from("NODE_OPTIONS=--require=/tmp/evil.js\nOPENAI_API_KEY=sk-openai"),
    );
    const result = sourceEnvFile("~/.bashrc");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(result).toHaveProperty("OPENAI_API_KEY", "sk-openai");
  });

  it("returns empty when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("returns empty when spawnSync throws", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("bash: source: file not found");
    });
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("returns empty when spawnSync reports error (bash not found)", () => {
    mockSpawnSync.mockReturnValue({
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      stdout: Buffer.from("MINIMAX_API_KEY=should_not_leak"),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
      error: new Error("bash not found"),
    } satisfies SpawnSyncReturns<Buffer>);
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("returns empty when spawnSync reports signal (process killed)", () => {
    mockSpawnSync.mockReturnValue({
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      stdout: Buffer.from("MINIMAX_API_KEY=should_not_leak"),
      stderr: Buffer.from(""),
      status: null,
      signal: "SIGKILL",
      error: undefined,
    } satisfies SpawnSyncReturns<Buffer>);
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("returns empty when spawnSync reports status null (process never exited)", () => {
    mockSpawnSync.mockReturnValue({
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      stdout: Buffer.from("MINIMAX_API_KEY=should_not_leak"),
      stderr: Buffer.from(""),
      status: null,
      signal: null,
      error: undefined,
    } satisfies SpawnSyncReturns<Buffer>);
    expect(sourceEnvFile("~/.bashrc")).toEqual({});
  });

  it("calls spawnSync with bash --noprofile --norc -i -c source and -- separator", () => {
    setSpawnSuccess(Buffer.from("MINIMAX_API_KEY=sk-test"));
    sourceEnvFile("~/.bashrc");
    const lastCall = mockSpawnSync.mock.lastCall;
    expect(lastCall).not.toBeUndefined();
    if (!lastCall) throw new Error("lastCall is undefined");
    const [cmd, args, options] = lastCall;
    expect(cmd).toBe("bash");
    expect(args).toBeDefined();
    if (!args) throw new Error("args is undefined");
    expect(args).toContain("--noprofile");
    expect(args).toContain("--norc");
    expect(args).toContain("-i");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toContain("source");
    expect(args).toContain("--");
    expect(options).toEqual(
      expect.objectContaining({
        detached: true,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("passes detached:true to spawnSync so the child survives parent termination", () => {
    setSpawnSuccess(Buffer.from("MY_VAR=hello"));
    sourceEnvFile("~/.bashrc");
    const lastCall = mockSpawnSync.mock.lastCall;
    expect(lastCall).not.toBeUndefined();
    if (!lastCall) throw new Error("lastCall is undefined");
    const options = lastCall[2];
    expect(options).toBeDefined();
    if (!options) throw new Error("options is undefined");
    expect(options.detached).toBe(true);
  });

  // regression: `&&` silently drops vars if sourced file exits non-zero (e.g.
  // bashrc with `set -e` or a failing command at the end). `;` runs `env`
  // regardless of the sourced file's exit status.
  it("uses semicolon separator so env runs even when sourced file exits non-zero", () => {
    setSpawnSuccess(Buffer.from("MINIMAX_API_KEY=sk-cp-test"));
    sourceEnvFile("~/.bashrc");
    const lastCall = mockSpawnSync.mock.lastCall;
    expect(lastCall).not.toBeUndefined();
    if (!lastCall) throw new Error("lastCall is undefined");
    const [, args] = lastCall;
    // Must use `--noprofile --norc` to prevent implicit bashrc sourcing,
    // `-i` so interactive-guard bashrc exports are NOT skipped, and `;` separator.
    expect(args).toBeDefined();
    if (!args) throw new Error("args is undefined");
    expect(args).toContain("--noprofile");
    expect(args).toContain("--norc");
    expect(args).toContain("-i");
    const shellScript = args[args.indexOf("-c") + 1];
    expect(shellScript).toMatch(/^source "\$1" > \/dev\/null 2>&1; env$/);
    expect(shellScript).not.toMatch(/&&/);
  });
});

describe("parseEnvOutput — blocklist (contract)", () => {
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

  it("includes custom non-blocked vars", () => {
    const output = "MY_CUSTOM_VAR=hello";
    expect(parseEnvOutput(output)).toHaveProperty("MY_CUSTOM_VAR", "hello");
  });

  it("excludes PATH, HOME, and other blocked system vars", () => {
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

  it("excludes BASH_ENV, BASH_FUNC_, NODE_OPTIONS", () => {
    const output = [
      "BASH_ENV=/tmp/evil.sh",
      "BASH_FUNC_foo%%=() { echo hi }",
      "NODE_OPTIONS=--require=/tmp/evil.js",
      "MY_VAR=safe",
    ].join("\n");
    const result = parseEnvOutput(output);
    expect(result).not.toHaveProperty("BASH_ENV");
    expect(result).not.toHaveProperty("BASH_FUNC_foo%%");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(result).toHaveProperty("MY_VAR", "safe");
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
    setSpawnSuccess(
      Buffer.from("MINIMAX_API_KEY=sk-cp-merged\nANTHROPIC_API_KEY=sk-ant-merged"),
    );
    applyEnvSource(["~/.bashrc"]);
    expect(process.env["MINIMAX_API_KEY"]).toBe("sk-cp-merged");
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-merged");
  });

  it("does not set vars when sourceEnvFile returns empty", () => {
    setSpawnSuccess(Buffer.from("PATH=/usr/bin\nHOME=/test"));
    applyEnvSource(["~/.bashrc"]);
    const key = "MINIMAX_API_KEY";
    expect(key in process.env ? process.env[key] : undefined).toBeUndefined();
    const key2 = "ANTHROPIC_API_KEY";
    expect(key2 in process.env ? process.env[key2] : undefined).toBeUndefined();
  });

  it("handles multiple source files by merging into process.env", () => {
    mockSpawnSync
      .mockReturnValueOnce({
        pid: 1,
        output: [null, Buffer.from("MINIMAX_API_KEY=sk-cp-first"), Buffer.from("")],
        stdout: Buffer.from("MINIMAX_API_KEY=sk-cp-first"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        error: undefined,
      } satisfies SpawnSyncReturns<Buffer>)
      .mockReturnValueOnce({
        pid: 1,
        output: [null, Buffer.from("ANTHROPIC_API_KEY=sk-ant-second"), Buffer.from("")],
        stdout: Buffer.from("ANTHROPIC_API_KEY=sk-ant-second"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        error: undefined,
      } satisfies SpawnSyncReturns<Buffer>);
    applyEnvSource(["~/.bashrc", "~/.zshrc"]);
    expect(process.env["MINIMAX_API_KEY"]).toBe("sk-cp-first");
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-second");
  });
});

describe("sourceEnvFile — /etc/environment direct parsing", () => {
  // /etc/environment is parsed as plain KEY=VALUE without bash sourcing.
  // mockReadFileSync is hoisted at module level — reference it directly.
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockSpawnSync.mockReset(); // clear calls from prior tests
    mockExistsSync.mockReturnValue(true);
  });

  it("parses plain KEY=VALUE entries (no export) from /etc/environment", () => {
    mockReadFileSync.mockReturnValue(
      "PATH=/usr/bin\nMINIMAX_API_KEY=sk-cp-test\nHOME=/test\n",
    );
    const result = sourceEnvFile("/etc/environment");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
    expect(result).not.toHaveProperty("PATH");
    expect(result).not.toHaveProperty("HOME");
  });

  it("parses KEY=VALUE entries with export prefix from /etc/environment", () => {
    mockReadFileSync.mockReturnValue(
      "export MINIMAX_API_KEY=sk-cp-export\nANTHROPIC_API_KEY=sk-ant-plain\n",
    );
    const result = sourceEnvFile("/etc/environment");
    // The `export ` prefix is stripped so the key becomes MINIMAX_API_KEY
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-export");
    expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-plain");
  });

  it("rejects bogus export-prefixed keys that remain blocked after stripping", () => {
    // After stripping "export ", the key becomes a blocked var like PATH
    mockReadFileSync.mockReturnValue(
      "export PATH=/malicious\nexport MINIMAX_API_KEY=sk-cp-ok\n",
    );
    const result = sourceEnvFile("/etc/environment");
    expect(result).not.toHaveProperty("PATH");
    expect(result).not.toHaveProperty("export PATH");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-ok");
  });

  it("skips comment and blank lines from /etc/environment", () => {
    mockReadFileSync.mockReturnValue("# this is a comment\n\nMINIMAX_API_KEY=sk-cp-test\n  \n# another comment\nANTHROPIC_API_KEY=sk-ant-test\n");
    const result = sourceEnvFile("/etc/environment");
    expect(result).toHaveProperty("MINIMAX_API_KEY", "sk-cp-test");
    expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("does not call spawnSync for /etc/environment (direct read only)", () => {
    mockReadFileSync.mockReturnValue("MINIMAX_API_KEY=sk-cp-test\n");
    sourceEnvFile("/etc/environment");
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns empty when /etc/environment does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = sourceEnvFile("/etc/environment");
    expect(result).toEqual({});
  });

  it("blocks dangerous vars from /etc/environment", () => {
    mockReadFileSync.mockReturnValue(
      "MINIMAX_API_KEY=sk-minimax\nANTHROPIC_API_KEY=sk-anthropic\nOPENAI_API_KEY=sk-openai\nMCP_AGENT_MAIL_URL=https://mail.example.com\nAO_CLI_PATH=/usr/local/bin/ao\nHOME=/test\nUSER=testuser\nBASH_ENV=/tmp/evil.sh\nNODE_OPTIONS=--require=/tmp/x.js\n",
    );
    const result = sourceEnvFile("/etc/environment");
    expect(result).toEqual({
      MINIMAX_API_KEY: "sk-minimax",
      ANTHROPIC_API_KEY: "sk-anthropic",
      OPENAI_API_KEY: "sk-openai",
      MCP_AGENT_MAIL_URL: "https://mail.example.com",
      AO_CLI_PATH: "/usr/local/bin/ao",
    });
    expect(result).not.toHaveProperty("HOME");
    expect(result).not.toHaveProperty("USER");
    expect(result).not.toHaveProperty("BASH_ENV");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
  });

  it("returns empty when readFileSync throws for /etc/environment", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("permission denied");
    });
    expect(sourceEnvFile("/etc/environment")).toEqual({});
  });
});
