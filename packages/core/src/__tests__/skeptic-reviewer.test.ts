/**
 * Tests for skeptic-reviewer.ts — runSkepticReview behavior.
 *
 * Uses vi.hoisted + vi.mock to create injectable mock functions for
 * node:child_process. Both execFile and exec are wrapped with
 * Symbol.for("nodejs.util.promisify.custom") so promisify() returns
 * the mock directly (avoids the callback-based default promisify path).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock functions — vi.hoisted runs before module imports,
// and the returned references are stable across vi.mock evaluation.
// ---------------------------------------------------------------------------
const { execFileMock, execMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<
    (
      file: string,
      args: string[],
      options?: { cwd?: string; timeout?: number },
    ) => Promise<{ stdout: string; stderr: string }>
  >(),
  execMock: vi.fn<
    (
      cmd: string,
      options?: { timeout?: number },
    ) => Promise<{ stdout: string; stderr: string }>
  >(),
}));

vi.mock("node:child_process", () => {
  const execFileImpl: typeof execFileMock = Object.assign(
    execFileMock,
    { [Symbol.for("nodejs.util.promisify.custom")]: execFileMock },
  ) as typeof execFileMock;
  const execImpl: typeof execMock = Object.assign(execMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: execMock,
  }) as typeof execMock;
  return { execFile: execFileImpl, exec: execImpl };
});

// ---------------------------------------------------------------------------
// Import the module under test — receives the mocked child_process
// ---------------------------------------------------------------------------
import { runSkepticReview } from "../skeptic-reviewer.js";
import type { Session, PRInfo } from "../types.js";

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: add widget",
    owner: "acme",
    repo: "app",
    branch: "feat/widget",
    baseBranch: "main",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe("runSkepticReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // AO_CLI_PATH in the host env overrides the "ao" binary name;
    // clear it so execFile calls use "ao" (matching test assertions).
    delete process.env.AO_CLI_PATH;
    // Default: gh api returns a valid SHA-1 (40 hex chars), ao skeptic returns PASS
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: PASS\nAll exit criteria met.",
      stderr: "",
    });
    execMock.mockResolvedValue({ stdout: "abc123def456789", stderr: "" });
  });

  it("skips when session has no PR", async () => {
    const session = makeSession({ pr: null });
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("SKIPPED");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("calls gh api to fetch PR head SHA", async () => {
    const session = makeSession();
    await runSkepticReview(session);
    // gh api now uses execFileAsync (not execAsync) for shell-injection safety
    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      ["api", "repos/acme/app/pulls/42", "--jq", ".head.sha"],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("passes --trigger-sha from gh api response to ao skeptic verify", async () => {
    // Set up execFileMock: first call (gh api) returns a valid SHA,
    // second call (ao skeptic) returns PASS (default from beforeEach)
    const mockResults = [
      { stdout: "abc123def4567890000000000000000000000000", stderr: "" }, // gh api: valid 40-char SHA
      { stdout: "VERDICT: PASS\nAll exit criteria met.", stderr: "" },  // ao skeptic
    ];
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" }); // reset
    for (const r of mockResults) {
      execFileMock.mockResolvedValueOnce(r);
    }
    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");
    // The ao skeptic call should include --trigger-sha with the validated SHA
    const aoCall = execFileMock.mock.calls.find((call) => call[0] === "ao");
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).toContain("--trigger-sha");
    expect(aoCall![1]).toContain("abc123def4567890000000000000000000000000");
  });

  it("omits --trigger-sha when gh api fails (non-fatal)", async () => {
    // Override gh api mock to reject — triggerSha remains undefined
    execFileMock.mockRejectedValueOnce(new Error("gh not found"));
    const session = makeSession();
    const result = await runSkepticReview(session);
    const aoCall = execFileMock.mock.calls.find(
      (call) => call[0] === "ao",
    );
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).not.toContain("--trigger-sha");
    expect(result.verdict).toBe("PASS");
  });

  it("succeeds when session.workspacePath is undefined (backfill session)", async () => {
    // workspacePath is string | null on Session — backfill sessions may lack one.
    const session = makeSession({ workspacePath: null });
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");
    expect(result.reportWritten).toBe(false);
    expect(execFileMock).toHaveBeenCalled();
  });

  it("maps VERDICT: FAIL from CLI to result.verdict = FAIL", async () => {
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: FAIL\nMissing unit tests.",
      stderr: "",
    });
    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("FAIL");
  });

  it("handles CLI crash (ENOENT) without throwing — returns SKIPPED after exhausting fallback chain", async () => {
    execFileMock.mockRejectedValue(
      Object.assign(new Error("ENOENT: ao not found"), { code: "ENOENT" }),
    );
    const session = makeSession();
    const result = await runSkepticReview(session);
    // With fallback chain (bd-skp3): all 3 models fail → SKIPPED (not FAIL)
    expect(result.verdict).toBe("SKIPPED");
    expect(result.details).toContain("ENOENT");
  });

  it("defaults model to codex", async () => {
    const session = makeSession();
    await runSkepticReview(session, { model: undefined });
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.arrayContaining(["--model", "codex"]),
      expect.any(Object),
    );
  });

  it("allows nested ao skeptic verify to run for fifteen minutes", async () => {
    const session = makeSession();
    await runSkepticReview(session);
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.arrayContaining(["skeptic", "verify"]),
      expect.objectContaining({ timeout: 900_000 }),
    );
  });

  it("passes model option to CLI", async () => {
    const session = makeSession();
    await runSkepticReview(session, { model: "claude" });
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.arrayContaining(["--model", "claude"]),
      expect.any(Object),
    );
  });

  it("skips --dry-run by default (postComment=true)", async () => {
    const session = makeSession();
    await runSkepticReview(session, { postComment: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.not.arrayContaining(["--dry-run"]),
      expect.any(Object),
    );
  });

  it("includes --dry-run when postComment=false", async () => {
    const session = makeSession();
    await runSkepticReview(session, { postComment: false });
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.arrayContaining(["--dry-run"]),
      expect.any(Object),
    );
  });

  it("reports modelUsed in result", async () => {
    const session = makeSession();
    const result = await runSkepticReview(session, { model: "gemini" });
    expect(result.modelUsed).toBe("gemini");
  });

  // bd-ryw2: VERDICT_LINE_RE now includes SKIPPED — previously only matched PASS|FAIL
  it("maps VERDICT: SKIPPED (infra unavailable) to result.verdict = SKIPPED", async () => {
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: SKIPPED\nANTHROPIC_API_KEY not configured — cannot run evaluation.",
      stderr: "",
    });
    const session = makeSession();
    const result = await runSkepticReview(session);
    // Before the fix, SKIPPED was absent from the (PASS|FAIL) capture-group alternation,
    // causing it to fall through to the "FAIL" default. Now it is a first-class verdict.
    expect(result.verdict).toBe("SKIPPED");
  });

  // ---------------------------------------------------------------------------
  // Fallback chain tests (bd-skp3) — codex → claude → gemini → SKIPPED
  // ---------------------------------------------------------------------------
  describe("LLM fallback chain", () => {
    it("falls back to claude when codex fails with ENOBUFS", async () => {
      const enobufsError = Object.assign(new Error("spawn ENOBUFS"), {
        code: "ENOBUFS",
      });
      // triggerSha is now fetched ONCE in runSkepticReview (not per tryModel)
      // Call 1: gh api (returns valid SHA)
      // Call 2: ao skeptic --model codex → ENOBUFS
      // Call 3: ao skeptic --model claude → PASS
      execFileMock
        .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
        .mockRejectedValueOnce(enobufsError) // codex fails
        .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // claude succeeds

      const session = makeSession();
      const result = await runSkepticReview(session);
      expect(result.verdict).toBe("PASS");
      expect(result.modelUsed).toBe("claude");
      // Regression: triggerSha must be fetched exactly once (not once per model)
      expect(execFileMock.mock.calls.filter((c) => c[0] === "gh")).toHaveLength(1);
      const aoModels = execFileMock.mock.calls
        .filter((c) => c[0] === "ao")
        .map((c) => c[1][c[1].indexOf("--model") + 1]);
      expect(aoModels).toEqual(["codex", "claude"]);
    });

    it("falls back to gemini when both codex and claude fail", async () => {
      const enobufsError = Object.assign(new Error("spawn ENOBUFS"), {
        code: "ENOBUFS",
      });
      const spawnSyncError = Object.assign(new Error("spawnSync ENOMEM"), {
        code: "ENOMEM",
      });
      // triggerSha fetched once — no repeated gh api calls per model attempt
      execFileMock
        .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
        .mockRejectedValueOnce(enobufsError) // codex fails
        .mockRejectedValueOnce(spawnSyncError) // claude fails
        .mockResolvedValueOnce({ stdout: "VERDICT: FAIL\nMissing tests.", stderr: "" }); // gemini succeeds

      const session = makeSession();
      const result = await runSkepticReview(session);
      expect(result.verdict).toBe("FAIL");
      expect(result.modelUsed).toBe("gemini");
    });

    it("returns SKIPPED (not FAIL) when all four models fail with infra errors", async () => {
      const enobufsError = Object.assign(new Error("spawn ENOBUFS"), {
        code: "ENOBUFS",
      });
      // triggerSha fetched once — one gh api call, then all 4 model attempts fail
      execFileMock
        .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
        .mockRejectedValueOnce(enobufsError) // codex fails
        .mockRejectedValueOnce(enobufsError) // claude fails
        .mockRejectedValueOnce(enobufsError) // gemini fails
        .mockRejectedValueOnce(enobufsError); // cursor fails

      const session = makeSession();
      const result = await runSkepticReview(session);
      expect(result.verdict).toBe("SKIPPED");
      expect(result.details).toContain("All models failed");
      expect(result.modelUsed).toBe("codex,claude,gemini,cursor");
    });

    it("does NOT retry when CLI returns a valid verdict (even FAIL)", async () => {
      // A FAIL verdict is a legitimate review — no fallback needed
      execFileMock.mockResolvedValue({
        stdout: "VERDICT: FAIL\nMissing unit tests.",
        stderr: "",
      });
      const session = makeSession();
      const result = await runSkepticReview(session);
      expect(result.verdict).toBe("FAIL");
      expect(result.modelUsed).toBe("codex");
      // Should only have 2 execFile calls: gh api + ao skeptic (no retries)
      const aoCalls = execFileMock.mock.calls.filter((c) => c[0] === "ao");
      expect(aoCalls.length).toBe(1);
    });

    it("does NOT retry when CLI exits non-zero but has stdout with VERDICT", async () => {
      // CLI crashed but managed to print VERDICT — use it, don't retry
      const exitErr = Object.assign(new Error("exit 1"), {
        code: 1,
        stdout: "VERDICT: FAIL\nPartial analysis.",
        stderr: "Warning: timeout",
      });
      execFileMock
        .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api
        .mockRejectedValueOnce(exitErr); // ao exits 1 but has verdict

      const session = makeSession();
      const result = await runSkepticReview(session);
      expect(result.verdict).toBe("FAIL");
      // Only 1 ao call — no fallback since we got a verdict
      const aoCalls = execFileMock.mock.calls.filter((c) => c[0] === "ao");
      expect(aoCalls.length).toBe(1);
    });

    it("retries with fallback when CLI exits non-zero with NO verdict in output", async () => {
      // CLI crashed with no verdict output — this is an infra failure
      const exitErr = Object.assign(new Error("exit 1"), {
        code: 1,
        stdout: "Error: ENOBUFS buffer overflow\n",
        stderr: "spawn error",
      });
      // triggerSha fetched once — one gh api call total
      execFileMock
        .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api (once)
        .mockRejectedValueOnce(exitErr) // codex: exit 1, no verdict
        .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // claude: PASS

      const session = makeSession();
      const result = await runSkepticReview(session);
      expect(result.verdict).toBe("PASS");
      expect(result.modelUsed).toBe("claude");
    });

    it("does NOT false-PASS when echoed prompt text contains VERDICT: PASS in early stdout", async () => {
      // Regression test for Codex comment #3067769649:
      // Prompt echo at start of stdout must not trigger hasVerdictInError.
      // Only the last 20 lines of stdout are checked for verdict.
      const fakePromptEcho = ["VERDICT: PASS"] // echoed template at top
        .concat(Array(25).fill("...infrastructure log...")) // push it past last-20 window
        .join("\n");
      const exitErr = Object.assign(new Error("spawn ENOBUFS"), {
        code: "ENOBUFS",
        stdout: fakePromptEcho,
        stderr: "",
      });
      execFileMock
        .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api (once)
        .mockRejectedValueOnce(exitErr) // codex: ENOBUFS with prompt echo, NOT a real verdict
        .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nReal analysis.", stderr: "" }); // claude: real PASS

      const session = makeSession();
      const result = await runSkepticReview(session);
      // Must fall back to claude (prompt echo must NOT be accepted as codex verdict)
      expect(result.verdict).toBe("PASS");
      expect(result.modelUsed).toBe("claude");
    });
  });
});
