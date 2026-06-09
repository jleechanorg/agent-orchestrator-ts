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

describe("runSkepticReview — LLM fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AO_CLI_PATH;
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: PASS\nAll exit criteria met.",
      stderr: "",
    });
    execMock.mockResolvedValue({ stdout: "abc123def456789", stderr: "" });
  });

  it("respects the custom-ordered array chain when model is a list", async () => {
    const enobufsError = Object.assign(new Error("spawn ENOBUFS"), {
      code: "ENOBUFS",
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments
      .mockRejectedValueOnce(enobufsError) // minimax fails
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // agy succeeds

    const session = makeSession();
    const result = await runSkepticReview(session, { model: ["minimax", "agy"] });
    expect(result.verdict).toBe("PASS");
    expect(result.modelUsed).toBe("agy");

    const aoCalls = execFileMock.mock.calls.filter((c) => c[0] === "ao");
    const aoModels = aoCalls.map((c) => c[1][c[1].indexOf("--model") + 1]);
    expect(aoModels).toEqual(["minimax", "agy"]);
  });

  it("falls back to claude when codex fails with ENOBUFS", async () => {
    const enobufsError = Object.assign(new Error("spawn ENOBUFS"), {
      code: "ENOBUFS",
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments --paginate --slurp (no request-id)
      .mockRejectedValueOnce(enobufsError) // codex fails
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // claude succeeds

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");
    expect(result.modelUsed).toBe("claude");
    expect(execFileMock.mock.calls.filter((c) => c[0] === "gh")).toHaveLength(2);
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
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments --paginate --slurp (no request-id)
      .mockRejectedValueOnce(enobufsError) // codex fails
      .mockRejectedValueOnce(spawnSyncError) // claude fails
      .mockResolvedValueOnce({ stdout: "VERDICT: FAIL\nMissing tests.", stderr: "" }); // gemini succeeds

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("FAIL");
    expect(result.modelUsed).toBe("gemini");
  });

  it("returns SKIPPED (not FAIL) when all models fail with infra errors", async () => {
    const enobufsError = Object.assign(new Error("spawn ENOBUFS"), {
      code: "ENOBUFS",
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments --paginate --slurp (no request-id)
      .mockRejectedValueOnce(enobufsError) // codex fails
      .mockRejectedValueOnce(enobufsError) // claude fails
      .mockRejectedValueOnce(enobufsError) // gemini fails
      .mockRejectedValueOnce(enobufsError) // minimax fails
      .mockRejectedValueOnce(enobufsError); // agy fails

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("SKIPPED");
    expect(result.details).toContain("All models failed");
    expect(result.modelUsed).toBe("codex,claude,gemini,minimax,agy");
  });

  it("does NOT retry when CLI returns a valid verdict (even FAIL)", async () => {
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: FAIL\nMissing unit tests.",
      stderr: "",
    });
    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("FAIL");
    expect(result.modelUsed).toBe("codex");
    const aoCalls = execFileMock.mock.calls.filter((c) => c[0] === "ao");
    expect(aoCalls.length).toBe(1);
  });

  it("does NOT retry when CLI exits non-zero but has stdout with VERDICT", async () => {
    const exitErr = Object.assign(new Error("exit 1"), {
      code: 1,
      stdout: "VERDICT: FAIL\nPartial analysis.",
      stderr: "Warning: timeout",
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments --paginate --slurp
      .mockRejectedValueOnce(exitErr); // ao exits 1 but has verdict

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("FAIL");
    const aoCalls = execFileMock.mock.calls.filter((c) => c[0] === "ao");
    expect(aoCalls.length).toBe(1);
  });

  it("retries with fallback when CLI exits non-zero with NO verdict in output", async () => {
    const exitErr = Object.assign(new Error("exit 1"), {
      code: 1,
      stdout: "Error: ENOBUFS buffer overflow\n",
      stderr: "spawn error",
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments --paginate --slurp (no request-id)
      .mockRejectedValueOnce(exitErr) // codex: exit 1, no verdict
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // claude: PASS

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");
    expect(result.modelUsed).toBe("claude");
  });

  it("does NOT false-PASS when echoed prompt text contains VERDICT: PASS in early stdout", async () => {
    const fakePromptEcho = ["VERDICT: PASS"] // echoed template at top
      .concat(Array(25).fill("...infrastructure log...")) // push it past last-20 window
      .join("\n");
    const exitErr = Object.assign(new Error("spawn ENOBUFS"), {
      code: "ENOBUFS",
      stdout: fakePromptEcho,
      stderr: "",
    });
    execFileMock
      .mockResolvedValueOnce({ stdout: "a".repeat(40), stderr: "" }) // gh api SHA (once)
      .mockResolvedValueOnce({ stdout: "[[]]", stderr: "" }) // gh api comments --paginate --slurp (no request-id)
      .mockRejectedValueOnce(exitErr) // codex: ENOBUFS with prompt echo, NOT a real verdict
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nReal analysis.", stderr: "" }); // claude: real PASS

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");
    expect(result.modelUsed).toBe("claude");
  });
});
