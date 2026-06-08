import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { runSkepticReview } from "../skeptic-reviewer.js";
import { makeSession } from "./skeptic-reviewer-helper.js";

describe("runSkepticReview — no-PR behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AO_CLI_PATH;
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

  it("skips when session has no PR and records modelUsed for string option", async () => {
    const sessionWithoutPr = makeSession({ pr: null });
    const result = await runSkepticReview(sessionWithoutPr, { model: "claude" });
    expect(result.verdict).toBe("SKIPPED");
    expect(result.modelUsed).toBe("claude");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it("skips when session has no PR and records modelUsed for array option", async () => {
    const sessionWithoutPr = makeSession({ pr: null });
    const result = await runSkepticReview(sessionWithoutPr, { model: ["claude", "gemini"] });
    expect(result.verdict).toBe("SKIPPED");
    expect(result.modelUsed).toBe("claude");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });
});
