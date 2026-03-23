import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  backfillUncoveredPRs,
  _resetBackfillTimer,
  type BackfillDeps,
  type BackfillParams,
} from "../backfill-extensions.js";
import type {
  PluginRegistry,
  SessionManager,
  Session,
  SCM,
  PRInfo,
  ProjectConfig,
} from "../types.js";
import type { ProjectObserver } from "../observability.js";

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 1,
    url: "https://github.com/org/repo/pull/1",
    title: "test pr",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-1",
    projectId: "proj",
    status: "working",
    activity: "active",
    branch: "feat/existing",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test",
    repo: "org/repo",
    path: "/tmp/repo",
    defaultBranch: "main",
    sessionPrefix: "test",
    scm: { plugin: "github" },
    backfillAllPRs: true,
    ...overrides,
  };
}

describe("backfillUncoveredPRs", () => {
  let mockSCM: SCM;
  let mockSessionManager: SessionManager;
  let mockObserver: ProjectObserver;
  let mockRegistry: PluginRegistry;
  let deps: BackfillDeps;

  beforeEach(() => {
    _resetBackfillTimer();

    mockSCM = {
      listOpenPRs: vi.fn<(p: ProjectConfig) => Promise<PRInfo[]>>().mockResolvedValue([]),
      detectPR: vi.fn().mockResolvedValue(null),
      getPRState: vi.fn().mockResolvedValue("open"),
      getCIChecks: vi.fn().mockResolvedValue([]),
      getCISummary: vi.fn().mockResolvedValue("pending"),
      getReviews: vi.fn().mockResolvedValue([]),
      getReviewDecision: vi.fn().mockResolvedValue("pending"),
      getPendingComments: vi.fn().mockResolvedValue([]),
      getAutomatedComments: vi.fn().mockResolvedValue([]),
      getMergeability: vi.fn().mockResolvedValue({ mergeable: false, reason: "unknown" }),
      mergePR: vi.fn().mockResolvedValue(undefined),
      closePR: vi.fn().mockResolvedValue(undefined),
    } as unknown as SCM;

    mockSessionManager = {
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "new-1" })),
      spawnOrchestrator: vi.fn(),
      restore: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      kill: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
      cleanup: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn<(id: string, ref: string) => Promise<{ sessionId: string; projectId: string; pr: PRInfo; branchChanged: boolean; githubAssigned: boolean; takenOverFrom: string[] }>>().mockResolvedValue({
        sessionId: "new-1",
        projectId: "proj",
        pr: makePR(),
        branchChanged: true,
        githubAssigned: false,
        takenOverFrom: [],
      }),
    };

    mockObserver = {
      component: "test",
      recordOperation: vi.fn(),
      setHealth: vi.fn(),
    };

    mockRegistry = {
      get: vi.fn().mockReturnValue(mockSCM),
      register: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
    } as unknown as PluginRegistry;

    deps = {
      registry: mockRegistry,
      sessionManager: mockSessionManager,
      observer: mockObserver,
    };
  });

  function makeParams(overrides: Partial<BackfillParams> = {}): BackfillParams {
    return {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "corr-1",
      ...overrides,
    };
  }

  it("returns false when called within the throttle interval", async () => {
    // First call sets the throttle timer (returns false because no open PRs)
    const result1 = await backfillUncoveredPRs(deps, makeParams());
    expect(result1).toBe(false);

    // Second call within 5 min should be throttled
    const result2 = await backfillUncoveredPRs(deps, makeParams());
    expect(result2).toBe(false);

    // listOpenPRs should only have been called once (second call was throttled)
    expect(mockSCM.listOpenPRs).toHaveBeenCalledTimes(1);
  });

  it("skips draft PRs", async () => {
    const draftPR = makePR({ number: 10, isDraft: true, branch: "feat/draft" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([draftPR]);

    const result = await backfillUncoveredPRs(deps, makeParams());
    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips PRs already covered by PR number", async () => {
    const pr = makePR({ number: 42, branch: "feat/covered" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const session = makeSession({ pr: { ...pr }, branch: "some-other-branch" });
    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [session] }),
    );

    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips PRs already covered by branch name", async () => {
    const pr = makePR({ number: 99, branch: "feat/branch-match" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const session = makeSession({ branch: "feat/branch-match", pr: null });
    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [session] }),
    );

    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("spawns a session for an uncovered PR and returns true", async () => {
    const pr = makePR({ number: 7, branch: "feat/new", title: "New feature" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledOnce();
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("new-1", "7");
  });

  it("kills the session and returns false when claimPR fails", async () => {
    const pr = makePR({ number: 5, branch: "feat/claim-fail" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    vi.mocked(mockSessionManager.claimPR).mockRejectedValue(new Error("claim boom"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(false);
    expect(mockSessionManager.kill).toHaveBeenCalledWith("new-1");

    // Should have recorded the claim failure
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.claim_failed",
        outcome: "failure",
      }),
    );
  });

  it("returns false and records error when listOpenPRs throws", async () => {
    vi.mocked(mockSCM.listOpenPRs!).mockRejectedValue(new Error("API down"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(false);
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.list_failed",
        outcome: "failure",
      }),
    );
  });

  it("returns false and records error when spawn throws", async () => {
    const pr = makePR({ number: 3, branch: "feat/spawn-fail" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    vi.mocked(mockSessionManager.spawn).mockRejectedValue(new Error("spawn boom"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(false);
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.spawn_failed",
        outcome: "failure",
      }),
    );
  });

  it("returns false when project has no SCM config", async () => {
    const project = makeProject({ scm: undefined });
    const result = await backfillUncoveredPRs(deps, makeParams({ project }));
    expect(result).toBe(false);
  });

  it("returns false when SCM plugin lacks listOpenPRs", async () => {
    const scmWithout = { ...mockSCM, listOpenPRs: undefined };
    vi.mocked(mockRegistry.get).mockReturnValue(scmWithout);

    const result = await backfillUncoveredPRs(deps, makeParams());
    expect(result).toBe(false);
  });

  it("spawns only the first uncovered PR per cycle", async () => {
    const prs = [
      makePR({ number: 1, branch: "feat/a" }),
      makePR({ number: 2, branch: "feat/b" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledOnce();
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("new-1", "1");
  });
});
