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
import { ConfigNotFoundError, type Session, type PRInfo } from "../types.js";

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

  it("drops a bare flag whose value placeholder resolved to empty, instead of leaving it dangling", async () => {
    mocks.loadConfigMock.mockReturnValue({
      projects: {
        "my-app": {
          reviewers: [
            {
              // Default execFile mock resolves the gh-api head-sha lookup to
              // "VERDICT: PASS\nAll good.", which is not a 40-hex-char SHA,
              // so triggerSha stays undefined and {trigger_sha} resolves to "".
              harness: "shell",
              cmd: ["tool", "--sha", "{trigger_sha}", "--repo", "{repo}"],
            },
          ],
        },
      },
    });

    const session = makeSession();
    await runSkepticReview(session, { postComment: false });

    const reviewerCall = mocks.execFileMock.mock.calls.find((c) => c[0] === "tool");
    expect(reviewerCall).toBeDefined();
    const [, args] = reviewerCall as [string, string[]];
    // "--sha" must not survive with no value once its placeholder is empty.
    expect(args).not.toContain("--sha");
    expect(args).toContain("--repo");
    expect(args).toContain("acme/app");
  });

  it("does not auto-append --dry-run based on literal skeptic/verify tokens in cmd", async () => {
    mocks.loadConfigMock.mockReturnValue({
      projects: {
        "my-app": {
          reviewers: [
            {
              harness: "shell",
              cmd: ["tool", "skeptic", "verify"],
            },
          ],
        },
      },
    });

    const session = makeSession();
    await runSkepticReview(session, { postComment: false });

    const reviewerCall = mocks.execFileMock.mock.calls.find((c) => c[0] === "tool");
    expect(reviewerCall).toBeDefined();
    const [, args] = reviewerCall as [string, string[]];
    expect(args).not.toContain("--dry-run");
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

  it("fails the review with a clear message when config fails to load/validate with a non-ConfigNotFoundError", async () => {
    mocks.loadConfigMock.mockImplementation(() => {
      throw new Error("YAML syntax error: line 5 column 1");
    });

    const session = makeSession();
    const result = await runSkepticReview(session);

    expect(result.verdict).toBe("FAIL");
    expect(result.details).toContain("Configuration loading error");
    expect(result.details).toContain("YAML syntax error");
    expect(result.modelUsed).toBe("config:loadConfig");
  });

  it("silently falls back to the default chain when config file does not exist (ConfigNotFoundError)", async () => {
    mocks.loadConfigMock.mockImplementation(() => {
      throw new ConfigNotFoundError();
    });

    const session = makeSession();
    const result = await runSkepticReview(session);

    // Should fall back to the default chain which returns PASS because of our mock setup
    expect(result.verdict).toBe("PASS");
  });
});

