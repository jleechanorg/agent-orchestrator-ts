import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockResolveCodexBinary = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  process.env["CLAUDE_BINARY"] = "/mock/claude";
});

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", () => ({
  accessSync: mockAccessSync,
  constants: { X_OK: 1 },
}));

vi.mock("@jleechanorg/ao-plugin-agent-codex", () => ({
  resolveCodexBinary: mockResolveCodexBinary,
}));

import { tryMinimaxPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";

let originalApiKeyGlobal: string | undefined;
let originalModelGlobal: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  
  mockAccessSync.mockImplementation((_path: unknown) => {
    const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });

  mockExecFileSync.mockImplementation(() => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });

  // Isolate tests from host GEMINI_API_KEY
  originalApiKeyGlobal = process.env["GEMINI_API_KEY"];
  originalModelGlobal = process.env["GEMINI_MODEL"];
  delete process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_MODEL"];
});

afterEach(() => {
  if (originalApiKeyGlobal !== undefined) {
    process.env["GEMINI_API_KEY"] = originalApiKeyGlobal;
  } else {
    delete process.env["GEMINI_API_KEY"];
  }
  if (originalModelGlobal !== undefined) {
    process.env["GEMINI_MODEL"] = originalModelGlobal;
  } else {
    delete process.env["GEMINI_MODEL"];
  }
});

describe("tryMinimaxPrint", () => {
  const allowFirstCandidate = () => {
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/claude" || path === "claude") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  };

  it("injects minimax credentials when calling tryMinimaxPrint", async () => {
    const originalMinimaxKey = process.env["MINIMAX_API_KEY"];
    const originalMinimaxBaseUrl = process.env["MINIMAX_ANTHROPIC_BASE_URL"];
    const originalAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    const originalAnthropicBaseUrl = process.env["ANTHROPIC_BASE_URL"];
    const originalAnthropicAuthToken = process.env["ANTHROPIC_AUTH_TOKEN"];

    process.env["MINIMAX_API_KEY"] = "minimax-test-key";
    process.env["MINIMAX_ANTHROPIC_BASE_URL"] = "https://minimax-base-url";
    try {
      allowFirstCandidate();
      mockExecFileSync.mockReturnValue(PASS_VERDICT);
      const result = await tryMinimaxPrint("evaluate this");
      expect(result.validVerdict).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/(^|\/)claude$/),
        ["--bare", "--dangerously-skip-permissions", "--print"],
        expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: "minimax-test-key",
            ANTHROPIC_AUTH_TOKEN: "minimax-test-key",
            ANTHROPIC_BASE_URL: "https://minimax-base-url",
          }),
        }),
      );
    } finally {
      if (originalMinimaxKey === undefined) delete process.env["MINIMAX_API_KEY"];
      else process.env["MINIMAX_API_KEY"] = originalMinimaxKey;
      if (originalMinimaxBaseUrl === undefined) delete process.env["MINIMAX_ANTHROPIC_BASE_URL"];
      else process.env["MINIMAX_ANTHROPIC_BASE_URL"] = originalMinimaxBaseUrl;
      if (originalAnthropicKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = originalAnthropicKey;
      if (originalAnthropicBaseUrl === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = originalAnthropicBaseUrl;
      if (originalAnthropicAuthToken === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"];
      else process.env["ANTHROPIC_AUTH_TOKEN"] = originalAnthropicAuthToken;
    }
  });

  it("retries on 429 rate-limit error in tryMinimaxPrint", async () => {
    const originalMinimaxKey = process.env["MINIMAX_API_KEY"];
    process.env["MINIMAX_API_KEY"] = "minimax-test-key";
    try {
      allowFirstCandidate();
      mockExecFileSync
        .mockImplementationOnce(() => {
          throw new Error("HTTP 429 Too Many Requests");
        })
        .mockReturnValueOnce(PASS_VERDICT);

      const result = await tryMinimaxPrint("evaluate this");
      expect(result.validVerdict).toBe(true);
      expect(result.output).toBe(PASS_VERDICT);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    } finally {
      if (originalMinimaxKey === undefined) delete process.env["MINIMAX_API_KEY"];
      else process.env["MINIMAX_API_KEY"] = originalMinimaxKey;
    }
  });

  it("continues to next candidate if first candidate throws EPERM but second candidate succeeds in tryMinimaxPrint", async () => {
    const originalMinimaxKey = process.env["MINIMAX_API_KEY"];
    process.env["MINIMAX_API_KEY"] = "minimax-test-key";
    const originalClaudeBinary = process.env["CLAUDE_BINARY"];
    process.env["CLAUDE_BINARY"] = "/mock/claude";
    try {
      mockAccessSync.mockImplementation((path: unknown) => {
        if (path === "/mock/claude" || path === "/opt/homebrew/bin/claude") return undefined;
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });

      const eperm = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      eperm.code = "EPERM";

      mockExecFileSync
        .mockImplementationOnce(() => {
          throw eperm;
        })
        .mockReturnValueOnce(PASS_VERDICT);

      const result = await tryMinimaxPrint("evaluate this");
      expect(result.validVerdict).toBe(true);
      expect(result.output).toBe(PASS_VERDICT);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    } finally {
      if (originalMinimaxKey === undefined) delete process.env["MINIMAX_API_KEY"];
      else process.env["MINIMAX_API_KEY"] = originalMinimaxKey;
      if (originalClaudeBinary === undefined) delete process.env["CLAUDE_BINARY"];
      else process.env["CLAUDE_BINARY"] = originalClaudeBinary;
    }
  });
});
