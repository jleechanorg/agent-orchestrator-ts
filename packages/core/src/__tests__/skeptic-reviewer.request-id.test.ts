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

describe("runSkepticReview — --request-id passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AO_CLI_PATH;
    execFileMock.mockResolvedValue({
      stdout: "VERDICT: PASS\nAll exit criteria met.",
      stderr: "",
    });
    execMock.mockResolvedValue({ stdout: "abc123def456789", stderr: "" });
  });

  it("passes --request-id when trigger comment contains a matching request-id marker", async () => {
    const validSha = "a".repeat(40);
    const requestId = "req-abc-123";
    const commentBody = [
      "SKEPTIC_GATE_TRIGGER",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${validSha} -->`,
      `<!-- skeptic-gate-trigger-${validSha} -->`,
    ].join("\n");
    const commentsJson = JSON.stringify([[{ body: commentBody, user: { login: "github-actions[bot]" } }]]);

    execFileMock
      .mockResolvedValueOnce({ stdout: validSha, stderr: "" })                    // gh api: SHA
      .mockResolvedValueOnce({ stdout: commentsJson, stderr: "" })                // gh api: comments (--paginate --slurp)
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // ao skeptic verify

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");

    const aoCall = execFileMock.mock.calls.find((c) => c[0] === "ao");
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).toContain("--request-id");
    expect(aoCall![1]).toContain(requestId);
  });

  it("omits --request-id when no trigger comment with request-id marker is found", async () => {
    const validSha = "a".repeat(40);
    const commentsJson = JSON.stringify([[{ body: "some unrelated comment", user: { login: "someone" } }]]);

    execFileMock
      .mockResolvedValueOnce({ stdout: validSha, stderr: "" })                    // gh api: SHA
      .mockResolvedValueOnce({ stdout: commentsJson, stderr: "" })                // gh api: comments
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // ao skeptic verify

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");

    const aoCall = execFileMock.mock.calls.find((c) => c[0] === "ao");
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).not.toContain("--request-id");
  });

  it("omits --request-id when gh api comments call fails (non-fatal)", async () => {
    const validSha = "a".repeat(40);

    execFileMock
      .mockResolvedValueOnce({ stdout: validSha, stderr: "" })                    // gh api: SHA
      .mockRejectedValueOnce(new Error("gh api comments failed"))                 // gh api: comments (fail)
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // ao skeptic verify

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");

    const aoCall = execFileMock.mock.calls.find((c) => c[0] === "ao");
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).not.toContain("--request-id");
  });

  it("passes --request-id through fallback chain (same request-id for all models)", async () => {
    const validSha = "a".repeat(40);
    const requestId = "req-fallback";
    const commentBody = [
      "SKEPTIC_GATE_TRIGGER",
      `<!-- skeptic-request-id-${requestId} -->`,
      `<!-- skeptic-head-sha-${validSha} -->`,
      `<!-- skeptic-gate-trigger-${validSha} -->`,
    ].join("\n");
    const commentsJson = JSON.stringify([[{ body: commentBody, user: { login: "github-actions[bot]" } }]]);

    const enobufsError = Object.assign(new Error("spawn ENOBUFS"), { code: "ENOBUFS" });
    execFileMock
      .mockResolvedValueOnce({ stdout: validSha, stderr: "" })                    // gh api: SHA
      .mockResolvedValueOnce({ stdout: commentsJson, stderr: "" })                // gh api: comments
      .mockRejectedValueOnce(enobufsError)                                        // codex fails
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // claude succeeds

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");
    expect(result.modelUsed).toBe("claude");

    const aoCalls = execFileMock.mock.calls.filter((c) => c[0] === "ao");
    for (const call of aoCalls) {
      expect(call[1]).toContain("--request-id");
      expect(call[1]).toContain(requestId);
    }
  });

  it("selects the latest matching request-id when multiple triggers share the same SHA", async () => {
    const validSha = "a".repeat(40);
    const oldRequestId = "req-old";
    const newRequestId = "req-new";
    const oldBody = [
      "SKEPTIC_GATE_TRIGGER",
      `<!-- skeptic-request-id-${oldRequestId} -->`,
      `<!-- skeptic-head-sha-${validSha} -->`,
      `<!-- skeptic-gate-trigger-${validSha} -->`,
    ].join("\n");
    const newBody = [
      "SKEPTIC_GATE_TRIGGER",
      `<!-- skeptic-request-id-${newRequestId} -->`,
      `<!-- skeptic-head-sha-${validSha} -->`,
      `<!-- skeptic-gate-trigger-${validSha} -->`,
    ].join("\n");
    const commentsJson = JSON.stringify([[
      { body: oldBody, user: { login: "github-actions[bot]" } },
      { body: newBody, user: { login: "github-actions[bot]" } },
    ]]);

    execFileMock
      .mockResolvedValueOnce({ stdout: validSha, stderr: "" })                    // gh api: SHA
      .mockResolvedValueOnce({ stdout: commentsJson, stderr: "" })                // gh api: comments (--paginate --slurp)
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // ao skeptic verify

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");

    const aoCall = execFileMock.mock.calls.find((c) => c[0] === "ao");
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).toContain("--request-id");
    expect(aoCall![1]).toContain(newRequestId);
    expect(aoCall![1]).not.toContain(oldRequestId);
  });

  it("requires skeptic-gate/cron-trigger marker to match (rejects stale triggers)", async () => {
    const validSha = "a".repeat(40);
    const commentBody = [
      "SKEPTIC_GATE_TRIGGER",
      `<!-- skeptic-request-id-req-stale -->`,
      `<!-- skeptic-head-sha-${validSha} -->`,
      // Missing <!-- skeptic-gate-trigger-{sha} --> marker
    ].join("\n");
    const commentsJson = JSON.stringify([[{ body: commentBody, user: { login: "github-actions[bot]" } }]]);

    execFileMock
      .mockResolvedValueOnce({ stdout: validSha, stderr: "" })                    // gh api: SHA
      .mockResolvedValueOnce({ stdout: commentsJson, stderr: "" })                // gh api: comments
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS\nAll good.", stderr: "" }); // ao skeptic verify

    const session = makeSession();
    const result = await runSkepticReview(session);
    expect(result.verdict).toBe("PASS");

    const aoCall = execFileMock.mock.calls.find((c) => c[0] === "ao");
    expect(aoCall).toBeDefined();
    expect(aoCall![1]).not.toContain("--request-id");
  });
});
