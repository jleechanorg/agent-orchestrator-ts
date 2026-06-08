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
import { makeSession } from "./skeptic-reviewer-helper.js";
describe("runSkepticReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AO_CLI_PATH;
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: PASS\nAll exit criteria met.",
      stderr: "",
    });
    execMock.mockResolvedValue({ stdout: "abc123def456789", stderr: "" });
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
    // Set up execFileMock: first call (gh api SHA) returns a valid SHA,
    // second call (gh api comments) returns empty, third call (ao skeptic) returns PASS
    const mockResults = [
      { stdout: "abc123def4567890000000000000000000000000", stderr: "" }, // gh api SHA
      { stdout: "[[]]", stderr: "" },  // gh api comments --paginate --slurp (no request-id)
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

  it("allows nested ao skeptic verify to run for thirty minutes", async () => {
    const session = makeSession();
    await runSkepticReview(session);
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.arrayContaining(["skeptic", "verify"]),
      expect.objectContaining({ timeout: 1800000 }),
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

  it("throws an error when model option is an empty array", async () => {
    const session = makeSession();
    await expect(
      runSkepticReview(session, { model: [] })
    ).rejects.toThrow("options.model must contain at least one model.");
  });

  it("throws an error when model option contains only invalid models", async () => {
    const session = makeSession();
    await expect(
      runSkepticReview(session, { model: ["cursor"] })
    ).rejects.toThrow("options.model must contain at least one valid model.");
  });

  it("throws an error when model option is a single invalid model", async () => {
    const session = makeSession();
    await expect(
      runSkepticReview(session, { model: "cursor" })
    ).rejects.toThrow("options.model must contain at least one valid model.");
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
});
