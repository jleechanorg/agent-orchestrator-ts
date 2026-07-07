import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execFileMock = vi.fn<
    (file: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>
  >();
  const writeFileMock = vi.fn<() => Promise<void>>();
  const mkdirMock = vi.fn<() => Promise<void>>();
  const loadConfigMock = vi.fn<() => any>();
  return { execFileMock, writeFileMock, mkdirMock, loadConfigMock };
});

vi.mock("node:child_process", () => {
  const { execFileMock } = mocks;
  const execFileWithP = Object.assign(execFileMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: execFileMock,
  });
  return { execFile: execFileWithP };
});

vi.mock("node:fs/promises", () => {
  const { writeFileMock, mkdirMock } = mocks;
  return { writeFile: writeFileMock, mkdir: mkdirMock };
});

vi.mock("../config.js", () => {
  return { loadConfig: mocks.loadConfigMock };
});

import { runSkepticReview } from "../skeptic-reviewer.js";
import type { Session, PRInfo } from "../types.js";

function makePR(): PRInfo {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: add widget",
    owner: "acme",
    repo: "app",
    branch: "feat/widget",
    baseBranch: "main",
  };
}

function makeSession(): Session {
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
  };
}

describe("runSkepticReview with custom reviewers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks behavior
    mocks.execFileMock.mockResolvedValue({ stdout: "VERDICT: PASS\nAll good.", stderr: "" });
    mocks.writeFileMock.mockResolvedValue();
    mocks.mkdirMock.mockResolvedValue();
  });

  it("runs configured shell reviewer and returns PASS", async () => {
    mocks.loadConfigMock.mockReturnValue({
      projects: {
        "my-app": {
          reviewers: [
            {
              harness: "shell",
              cmd: ["ao", "skeptic", "verify", "--pr", "{pr_number}", "--repo", "{repo}", "{dry_run}"],
              env: { TEST_ENV: "hello" },
            },
          ],
        },
      },
    });

    const session = makeSession();
    const result = await runSkepticReview(session, { postComment: false });

    expect(result.verdict).toBe("PASS");
    expect(result.modelUsed).toContain("shell:ao skeptic verify");
    
    // Verify execFile was called with correct command
    expect(mocks.execFileMock).toHaveBeenCalled();
    const reviewerCall = mocks.execFileMock.mock.calls.find(
      (c) => !c[0].endsWith("gh") && c[0] !== "gh"
    );
    expect(reviewerCall).toBeDefined();
    const [file, args, opts] = reviewerCall as [string, string[], any];
    expect(file).toBe(process.env["AO_CLI_PATH"] ?? "ao");
    expect(args).toContain("--pr");
    expect(args).toContain("42");
    expect(args).toContain("--repo");
    expect(args).toContain("acme/app");
    expect(args).toContain("--dry-run"); // Because postComment was false and placeholder replaced
    expect(opts.env.TEST_ENV).toBe("hello");
  });

  it("combines multiple reviewer results and fails if any reviewer fails", async () => {
    mocks.loadConfigMock.mockReturnValue({
      projects: {
        "my-app": {
          reviewers: [
            {
              harness: "shell",
              cmd: ["echo", "first"],
            },
            {
              harness: "shell",
              cmd: ["echo", "second"],
            },
          ],
        },
      },
    });

    // Mock first call passing, second call failing
    mocks.execFileMock
      .mockResolvedValueOnce({ stdout: "VERDICT: PASS", stderr: "" })
      .mockResolvedValueOnce({ stdout: "VERDICT: FAIL\nDid not pass.", stderr: "" });

    const session = makeSession();
    const result = await runSkepticReview(session, { postComment: true });

    expect(result.verdict).toBe("FAIL");
    expect(result.details).toContain("Reviewer 1");
    expect(result.details).toContain("PASS");
    expect(result.details).toContain("Reviewer 2");
    expect(result.details).toContain("FAIL");
  });

  it("handles empty command array gracefully", async () => {
    mocks.loadConfigMock.mockReturnValue({
      projects: {
        "my-app": {
          reviewers: [
            {
              harness: "shell",
              cmd: [],
            },
          ],
        },
      },
    });

    const session = makeSession();
    const result = await runSkepticReview(session);

    expect(result.verdict).toBe("FAIL");
    expect(result.details).toContain("Infrastructure error");
  });

  it("throws on unsupported harnesses", async () => {
    mocks.loadConfigMock.mockReturnValue({
      projects: {
        "my-app": {
          reviewers: [
            {
              harness: "unsupported",
              cmd: ["echo", "test"],
            },
          ],
        },
      },
    });

    const session = makeSession();
    const result = await runSkepticReview(session);

    expect(result.verdict).toBe("FAIL");
    expect(result.details).toContain("Unsupported reviewer harness");
  });
});
