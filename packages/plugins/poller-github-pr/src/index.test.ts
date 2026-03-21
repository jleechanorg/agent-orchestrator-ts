/**
 * Tests for poller-github-pr plugin.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import type { SessionManager, Session, SessionSpawnConfig, PollerWorkItem } from "@jleechanorg/ao-core";
import pluginModule, { manifest, create } from "./index.js";

type MockExecFile = ReturnType<typeof vi.fn>;

function mockGhOutput(json: unknown): void {
  const mockExecFile = execFile as unknown as MockExecFile;
  mockExecFile.mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string }) => void,
    ) => {
      callback(null, { stdout: JSON.stringify(json) });
    },
  );
}

function mockGhError(message: string): void {
  const mockExecFile = execFile as unknown as MockExecFile;
  mockExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error(message));
    },
  );
}

const BASE_PR = {
  number: 1,
  title: "Test PR",
  url: "https://github.com/owner/repo/pull/1",
  isDraft: false,
  headRefName: "feat/test",
  baseRefName: "main",
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ state: "SUCCESS", conclusion: "success" }],
};

const CODERABBIT_CHANGES_REQUESTED = {
  author: { login: "coderabbitai[bot]" },
  state: "CHANGES_REQUESTED",
  submittedAt: "2026-03-20T20:00:00Z",
};

const CODERABBIT_APPROVED = {
  author: { login: "coderabbitai[bot]" },
  state: "APPROVED",
  submittedAt: "2026-03-20T20:00:00Z",
};

describe("poller-github-pr plugin module", () => {
  it("exports a valid plugin manifest", () => {
    expect(manifest.name).toBe("github-pr");
    expect(manifest.slot).toBe("poller");
    expect(manifest.version).toBeTruthy();
    expect(manifest.description).toBeTruthy();
  });

  it("default export satisfies PluginModule shape", () => {
    expect(pluginModule.manifest).toBe(manifest);
    expect(typeof pluginModule.create).toBe("function");
  });
});

describe("poll()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no open PRs", async () => {
    mockGhOutput([]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
  });

  it("returns empty array when CodeRabbit has approved", async () => {
    mockGhOutput([{ ...BASE_PR, latestReviews: [CODERABBIT_APPROVED] }]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
  });

  it("returns work item only for CodeRabbit CHANGES_REQUESTED", async () => {
    mockGhOutput([{ ...BASE_PR, number: 2, latestReviews: [CODERABBIT_CHANGES_REQUESTED] }]);
    const poller = create();
    const items = await poller.poll("test-project");

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("pr-2");
    expect(items[0].metadata?.reasons).toContain("changes-requested");
    expect(items[0].metadata?.codeRabbitState).toBe("CHANGES_REQUESTED");
  });

  it("ignores CHANGES_REQUESTED from non-CodeRabbit reviewers", async () => {
    mockGhOutput([
      {
        ...BASE_PR,
        latestReviews: [
          {
            author: { login: "human-reviewer" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-03-20T21:00:00Z",
          },
        ],
      },
    ]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
  });

  it("uses latest decisive CodeRabbit review state", async () => {
    mockGhOutput([
      {
        ...BASE_PR,
        latestReviews: [
          { ...CODERABBIT_CHANGES_REQUESTED, submittedAt: "2026-03-20T18:00:00Z" },
          { ...CODERABBIT_APPROVED, submittedAt: "2026-03-20T22:00:00Z" },
        ],
      },
    ]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
  });

  it("raises priority when CI is failing in addition to CodeRabbit changes requested", async () => {
    mockGhOutput([
      {
        ...BASE_PR,
        number: 3,
        statusCheckRollup: [{ state: "FAILURE", conclusion: "failure" }],
        latestReviews: [CODERABBIT_CHANGES_REQUESTED],
      },
    ]);
    const poller = create();
    const items = await poller.poll("test-project");

    expect(items).toHaveLength(1);
    expect(items[0].priority).toBe(1);
    expect(items[0].metadata?.reasons).toContain("ci-failing");
  });

  it("passes --repo flag when repo config is provided", async () => {
    mockGhOutput([]);
    const poller = create({ repo: "owner/repo" });
    await poller.poll("test-project");
    const mockExecFile = execFile as unknown as MockExecFile;
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).toContain("--repo");
    expect(callArgs).toContain("owner/repo");
    expect(callArgs.join(",")).toContain("latestReviews");
  });

  it("throws a descriptive error when gh CLI fails with non-rate-limit error", async () => {
    mockGhError("authentication required");
    const poller = create();
    await expect(poller.poll("test-project")).rejects.toThrow("Failed to list PRs");
  });

  it("retries on rate limit error and succeeds on second attempt", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockExecFile = execFile as unknown as MockExecFile;
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, callback: (err: Error | null, result?: { stdout: string }) => void) => {
        callCount++;
        if (callCount === 1) {
          callback(new Error("API rate limit exceeded"));
        } else {
          callback(null, { stdout: JSON.stringify([{ ...BASE_PR, latestReviews: [CODERABBIT_CHANGES_REQUESTED] }]) });
        }
      },
    );
    const poller = create({ repo: "owner/repo" });
    const items = await poller.poll("test-project");
    expect(items).toHaveLength(1);
    expect(callCount).toBe(2);
    warnSpy.mockRestore();
  });

  it("falls back to REST API when all rate limit retries exhausted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mockExecFile = execFile as unknown as MockExecFile;
    let _callCount = 0;
    const restPrs = [
      {
        number: 5,
        title: "REST PR",
        html_url: "https://github.com/owner/repo/pull/5",
        draft: false,
        head: { ref: "feat/rest" },
        base: { ref: "main" },
        mergeable: true,
      },
    ];
    mockExecFile.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, callback: (err: Error | null, result?: { stdout: string }) => void) => {
        _callCount++;
        if ((args as string[])[0] === "pr") {
          // All gh pr list calls fail with rate limit
          callback(new Error("API rate limit exceeded"));
        } else if ((args as string[])[0] === "api") {
          // REST fallback succeeds
          callback(null, { stdout: JSON.stringify(restPrs) });
        }
      },
    );
    const poller = create({ repo: "owner/repo" });
    const items = await poller.poll("test-project");
    // REST fallback returns PRs but without latestReviews, so no CHANGES_REQUESTED
    // items will be detected — the important thing is it doesn't throw
    expect(items).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("falling back to REST API"));
    warnSpy.mockRestore();
  });
});

describe("spawnSession()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and warns when no sessionManager is configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poller = create();
    const workItem: PollerWorkItem = {
      id: "pr-2",
      type: "open-pr",
      title: "PR needs CodeRabbit fixes",
      url: "https://github.com/owner/repo/pull/2",
      metadata: { prNumber: 2, reasons: ["changes-requested"] },
    };
    const spawnConfig: SessionSpawnConfig = { projectId: "test-project" };
    const result = await poller.spawnSession(workItem, "test-project", spawnConfig);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No sessionManager configured"));
    warnSpy.mockRestore();
  });

  it("calls sessionManager.spawn with enriched prompt", async () => {
    const fakeSession = { id: "test-1" } as unknown as Session;
    const mockSessionManager: Partial<SessionManager> = {
      spawn: vi.fn().mockResolvedValue(fakeSession),
    };

    const poller = create({ sessionManager: mockSessionManager as SessionManager });

    const workItem: PollerWorkItem = {
      id: "pr-2",
      type: "open-pr",
      title: "PR needs CodeRabbit fixes",
      url: "https://github.com/owner/repo/pull/2",
      priority: 1,
      metadata: { prNumber: 2, reasons: ["changes-requested", "ci-failing"] },
    };

    const spawnConfig: SessionSpawnConfig = { projectId: "test-project", agent: "claude-code" };
    const result = await poller.spawnSession(workItem, "test-project", spawnConfig);

    expect(result).toBe(fakeSession);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        agent: "claude-code",
        prompt: expect.stringContaining("changes-requested"),
      }),
    );
  });
});
