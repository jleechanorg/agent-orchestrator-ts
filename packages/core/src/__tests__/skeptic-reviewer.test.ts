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
    // Default: gh returns a SHA, ao skeptic returns PASS
    execMock.mockResolvedValue({ stdout: "abc123def456789", stderr: "" });
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: PASS\nAll exit criteria met.",
      stderr: "",
    });
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
    expect(execMock).toHaveBeenCalledWith(
      "gh api repos/acme/app/pulls/42 --jq .head.sha",
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("passes --trigger-sha from gh api response to ao skeptic verify", async () => {
    execMock.mockResolvedValue({ stdout: "abc123def456789", stderr: "" });
    const session = makeSession();
    await runSkepticReview(session);
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.arrayContaining(["--trigger-sha", "abc123def456789"]),
      expect.any(Object),
    );
  });

  it("omits --trigger-sha when gh api fails (non-fatal)", async () => {
    execMock.mockRejectedValue(new Error("gh not found"));
    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(execFileMock).toHaveBeenCalledWith(
      "ao",
      expect.not.arrayContaining(["--trigger-sha"]),
      expect.any(Object),
    );
    expect(result.verdict).toBe("PASS");
  });

  it("succeeds when session.workspacePath is undefined (backfill session)", async () => {
    const session = makeSession({ workspacePath: undefined as unknown as string });
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

  it("handles CLI crash (ENOENT) without throwing", async () => {
    execFileMock.mockRejectedValue(
      Object.assign(new Error("ENOENT: ao not found"), { code: "ENOENT" }),
    );
    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("FAIL");
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
});
