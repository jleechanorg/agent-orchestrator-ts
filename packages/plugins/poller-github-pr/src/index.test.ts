/**
 * Tests for poller-github-pr plugin.
 *
 * Uses vitest's vi.mock to stub child_process.execFile so no real GitHub calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import type { SessionManager, Session, SessionSpawnConfig, PollerWorkItem } from "@composio/ao-core";
import pluginModule, { manifest, create } from "./index.js";

type MockExecFile = ReturnType<typeof vi.fn>;

// Helper to set up execFile mock with a JSON response
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

// Helper to set up execFile mock to throw an error
function mockGhError(message: string): void {
  const mockExecFile = execFile as unknown as MockExecFile;
  mockExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error(message));
    },
  );
}

const GREEN_PR = {
  number: 1,
  title: "Green PR",
  url: "https://github.com/owner/repo/pull/1",
  isDraft: false,
  headRefName: "feat/green",
  baseRefName: "main",
  statusCheckRollup: [{ state: "SUCCESS", conclusion: "success" }],
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
};

const FAILING_CI_PR = {
  number: 2,
  title: "Failing CI PR",
  url: "https://github.com/owner/repo/pull/2",
  isDraft: false,
  headRefName: "feat/failing-ci",
  baseRefName: "main",
  statusCheckRollup: [{ state: "FAILURE", conclusion: "failure" }],
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
};

const CHANGES_REQUESTED_PR = {
  number: 3,
  title: "Changes Requested PR",
  url: "https://github.com/owner/repo/pull/3",
  isDraft: false,
  headRefName: "feat/changes-requested",
  baseRefName: "main",
  statusCheckRollup: [{ state: "SUCCESS", conclusion: "success" }],
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "MERGEABLE",
};

const DRAFT_PR = {
  number: 4,
  title: "Draft PR",
  url: "https://github.com/owner/repo/pull/4",
  isDraft: true,
  headRefName: "feat/draft",
  baseRefName: "main",
  statusCheckRollup: null,
  reviewDecision: null,
  mergeable: "MERGEABLE",
};

const CONFLICT_PR = {
  number: 5,
  title: "Conflicting PR",
  url: "https://github.com/owner/repo/pull/5",
  isDraft: false,
  headRefName: "feat/conflict",
  baseRefName: "main",
  statusCheckRollup: [{ state: "SUCCESS", conclusion: "success" }],
  reviewDecision: "APPROVED",
  mergeable: "CONFLICTING",
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

  it("create() returns a Poller with the correct name", () => {
    const poller = create();
    expect(poller.name).toBe("github-pr");
    expect(typeof poller.poll).toBe("function");
    expect(typeof poller.spawnSession).toBe("function");
  });

  it("exposes setSessionManager for late injection", () => {
    const poller = create();
    expect(typeof poller.setSessionManager).toBe("function");
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

  it("returns empty array when all PRs are green", async () => {
    mockGhOutput([GREEN_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
  });

  it("returns work items for PRs with failing CI", async () => {
    mockGhOutput([FAILING_CI_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("pr-2");
    expect(items[0].type).toBe("open-pr");
    expect(items[0].title).toBe("Failing CI PR");
    expect(items[0].metadata?.reasons).toContain("ci-failing");
  });

  it("returns work items for PRs with changes requested", async () => {
    mockGhOutput([CHANGES_REQUESTED_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toHaveLength(1);
    expect(items[0].metadata?.reasons).toContain("changes-requested");
  });

  it("skips draft PRs", async () => {
    mockGhOutput([DRAFT_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
  });

  it("returns work item for PRs with merge conflicts", async () => {
    mockGhOutput([CONFLICT_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toHaveLength(1);
    expect(items[0].metadata?.reasons).toContain("merge-conflicts");
  });

  it("assigns priority 1 to CI-failing PRs and 2 to review-only PRs", async () => {
    mockGhOutput([FAILING_CI_PR, CHANGES_REQUESTED_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toHaveLength(2);
    const ciFailing = items.find((i) => i.metadata?.prNumber === 2);
    const changesReq = items.find((i) => i.metadata?.prNumber === 3);
    expect(ciFailing?.priority).toBe(1);
    expect(changesReq?.priority).toBe(2);
  });

  it("skips green PRs and returns non-green ones from a mixed list", async () => {
    mockGhOutput([GREEN_PR, FAILING_CI_PR, DRAFT_PR]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toHaveLength(1);
    expect(items[0].metadata?.prNumber).toBe(2);
  });

  it("throws a descriptive error when gh CLI fails", async () => {
    mockGhError("authentication required");
    const poller = create();
    await expect(poller.poll("test-project")).rejects.toThrow("Failed to list PRs");
  });

  it("passes --repo flag when repo config is provided", async () => {
    mockGhOutput([]);
    const poller = create({ repo: "owner/repo" });
    await poller.poll("test-project");
    const mockExecFile = execFile as unknown as MockExecFile;
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).toContain("--repo");
    expect(callArgs).toContain("owner/repo");
  });

  it("treats PR with no CI checks as passing (no CI configured)", async () => {
    const noCiPr = { ...GREEN_PR, number: 99, statusCheckRollup: [] };
    mockGhOutput([noCiPr]);
    const poller = create();
    const items = await poller.poll("test-project");
    expect(items).toEqual([]);
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
      title: "Failing CI PR",
      url: "https://github.com/owner/repo/pull/2",
      metadata: { prNumber: 2, reasons: ["ci-failing"] },
    };
    const spawnConfig: SessionSpawnConfig = { projectId: "test-project" };
    const result = await poller.spawnSession(workItem, "test-project", spawnConfig);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No sessionManager configured"));
    warnSpy.mockRestore();
  });

  it("calls sessionManager.spawn with correct config", async () => {
    const fakeSession = { id: "test-1" } as unknown as Session;
    const mockSessionManager: Partial<SessionManager> = {
      spawn: vi.fn().mockResolvedValue(fakeSession),
    };

    const poller = create({ sessionManager: mockSessionManager as SessionManager });

    const workItem: PollerWorkItem = {
      id: "pr-2",
      type: "open-pr",
      title: "Failing CI PR",
      url: "https://github.com/owner/repo/pull/2",
      priority: 1,
      metadata: { prNumber: 2, reasons: ["ci-failing"] },
    };

    const spawnConfig: SessionSpawnConfig = { projectId: "test-project", agent: "claude-code" };
    const result = await poller.spawnSession(workItem, "test-project", spawnConfig);

    expect(result).toBe(fakeSession);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        agent: "claude-code",
        prompt: expect.stringContaining("Failing CI PR"),
      }),
    );
  });

  it("works with setSessionManager (late injection from poller-manager)", async () => {
    const fakeSession = { id: "test-late" } as unknown as Session;
    const mockSessionManager: Partial<SessionManager> = {
      spawn: vi.fn().mockResolvedValue(fakeSession),
    };

    // Create without sessionManager, then inject late
    const poller = create();
    poller.setSessionManager(mockSessionManager as SessionManager);

    const workItem: PollerWorkItem = {
      id: "pr-10",
      type: "open-pr",
      title: "Late Inject PR",
      url: "https://github.com/owner/repo/pull/10",
      metadata: { prNumber: 10, reasons: ["ci-failing"] },
    };

    const spawnConfig: SessionSpawnConfig = { projectId: "test-project" };
    const result = await poller.spawnSession(workItem, "test-project", spawnConfig);

    expect(result).toBe(fakeSession);
    expect(mockSessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        prompt: expect.stringContaining("Late Inject PR"),
      }),
    );
  });

  it("uses custom prompt from config when provided", async () => {
    const fakeSession = { id: "test-1" } as unknown as Session;
    const mockSessionManager: Partial<SessionManager> = {
      spawn: vi.fn().mockResolvedValue(fakeSession),
    };

    const poller = create({ sessionManager: mockSessionManager as SessionManager });

    const workItem: PollerWorkItem = {
      id: "pr-2",
      type: "open-pr",
      title: "Failing CI PR",
      url: "https://github.com/owner/repo/pull/2",
      metadata: { prNumber: 2, reasons: ["ci-failing"] },
    };

    const customPrompt = "Custom fix prompt for this PR";
    const spawnConfig: SessionSpawnConfig = { projectId: "test-project", prompt: customPrompt };
    await poller.spawnSession(workItem, "test-project", spawnConfig);

    // Custom prompt is enriched with PR-specific context (reasons, URL)
    const spawnCall = (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(spawnCall.prompt).toContain(customPrompt);
    expect(spawnCall.prompt).toContain("Failing CI PR");
    expect(spawnCall.prompt).toContain("ci-failing");
  });
});
