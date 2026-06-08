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

import { tryClaudePrint, tryMinimaxPrint } from "../../src/lib/llm-eval.js";

const PASS_VERDICT = "VERDICT: PASS";
const SKIPPED_VERDICT = "VERDICT: SKIPPED";

let originalApiKeyGlobal: string | undefined;
let originalModelGlobal: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockResolveCodexBinary.mockReset();
  // accessSync: throw ENOENT for all candidates (binary not found).
  // This makes tryClaudePrint skip every candidate without succeeding,
  // so the rotation advances to the next tool (not a 2nd claude candidate).
  mockAccessSync.mockImplementation((_path: unknown) => {
    const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  // Default: throw ENOENT for ALL execFileSync calls.
  // Each test queues specific return values for the calls it cares about.
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

function makeErrnoError(message: string, code?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("tryClaudePrint", () => {
  // Override accessSync to allow /mock/claude (first candidate) through.
  // Without this, accessSync throws ENOENT and tryClaudePrint skips all candidates.
  const allowFirstCandidate = () => {
    mockAccessSync.mockImplementation((path: unknown) => {
      if (path === "/mock/claude" || path === "claude") return undefined;
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  };

  it("returns validVerdict=true for output containing VERDICT: PASS", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue(PASS_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/(^|\/)claude$/),
      ["--bare", "--dangerously-skip-permissions", "--print"],
      expect.objectContaining({
        input: "evaluate this",
        cwd: "/tmp",
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 300_000,
      }),
    );
  });

  it("does not include minimax-specific env in tryClaudePrint even if MINIMAX_API_KEY is configured", async () => {
    const originalMinimaxKey = process.env["MINIMAX_API_KEY"];
    const originalAnthropicKey = process.env["ANTHROPIC_API_KEY"];
    const originalMinimaxBaseUrl = process.env["MINIMAX_ANTHROPIC_BASE_URL"];
    const originalAnthropicBaseUrl = process.env["ANTHROPIC_BASE_URL"];
    const originalAnthropicAuthToken = process.env["ANTHROPIC_AUTH_TOKEN"];

    process.env["MINIMAX_API_KEY"] = "minimax-test-key";
    process.env["MINIMAX_ANTHROPIC_BASE_URL"] = "https://minimax-base-url";
    process.env["ANTHROPIC_API_KEY"] = "real-anthropic-key";
    try {
      allowFirstCandidate();
      mockExecFileSync.mockReturnValue(PASS_VERDICT);
      await tryClaudePrint("evaluate this");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/(^|\/)claude$/),
        ["--bare", "--dangerously-skip-permissions", "--print"],
        expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_API_KEY: "real-anthropic-key",
          }),
        }),
      );
      const callArgs = mockExecFileSync.mock.calls[0][2];
      expect(callArgs.env.ANTHROPIC_BASE_URL).not.toBe("https://minimax-base-url");
    } finally {
      if (originalMinimaxKey === undefined) delete process.env["MINIMAX_API_KEY"];
      else process.env["MINIMAX_API_KEY"] = originalMinimaxKey;
      if (originalAnthropicKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = originalAnthropicKey;
      if (originalMinimaxBaseUrl === undefined) delete process.env["MINIMAX_ANTHROPIC_BASE_URL"];
      else process.env["MINIMAX_ANTHROPIC_BASE_URL"] = originalMinimaxBaseUrl;
      if (originalAnthropicBaseUrl === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = originalAnthropicBaseUrl;
      if (originalAnthropicAuthToken === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"];
      else process.env["ANTHROPIC_AUTH_TOKEN"] = originalAnthropicAuthToken;
    }
  });

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

  it("returns validVerdict=false with error string when VERDICT is missing", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("Some analysis without verdict");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
    expect(result.error).toBeDefined();
  });

  it("returns error=undefined when binary is not found", async () => {
    const err = makeErrnoError("ENOENT: not found", "ENOENT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("returns error=undefined for ETIMEDOUT (unavailable) on first candidate", async () => {
    const err = makeErrnoError("ETIMEDOUT", "ETIMEDOUT");
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    // ETIMEDOUT is "unavailable" — try next binary candidate
    expect(result.error).toBeUndefined();
  });

  it("returns validVerdict=true for markdown-prefixed ## VERDICT: PASS", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("## VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("## VERDICT: PASS");
  });

  it("returns validVerdict=false for VERDICT: SKIPPED", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue(SKIPPED_VERDICT);
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("rejects embedded mid-sentence verdicts", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("Analysis complete. VERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(false);
    expect(result.error).toContain("missing VERDICT line");
  });

  it("accepts indented verdict lines", async () => {
    allowFirstCandidate();
    mockExecFileSync.mockReturnValue("\tVERDICT: PASS");
    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe("VERDICT: PASS");
  });

  it("retries on 429 rate-limit error and returns validVerdict=true if retry succeeds", async () => {
    allowFirstCandidate();
    // First call throws a 429 rate-limit error; second call succeeds with PASS_VERDICT
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error("HTTP 429 Too Many Requests — rate limit exceeded");
      })
      .mockReturnValueOnce(PASS_VERDICT);

    const result = await tryClaudePrint("evaluate this");
    expect(result.validVerdict).toBe(true);
    expect(result.output).toBe(PASS_VERDICT);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
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
