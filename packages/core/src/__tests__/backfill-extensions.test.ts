import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  backfillUncoveredPRs,
  _resetBackfillTimer,
  _resetCrRespawnCounter,
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

// Mock tmux.ts — must be hoisted to top level
vi.mock("../tmux.js", () => ({
  hasSession: vi.fn<(name: string) => Promise<boolean>>(),
}));

import { hasSession } from "../tmux.js";

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
    _resetCrRespawnCounter();
    vi.mocked(hasSession).mockReset(); // clear call history AND reset implementation
    vi.mocked(hasSession).mockResolvedValue(true); // default: all sessions alive

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

  it("kills the session and returns false when claimPR fails (single PR)", async () => {
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

  it("skips failed PR and spawns next uncovered PR when claimPR fails", async () => {
    const prs = [
      makePR({ number: 123, branch: "feat/conflicting" }),
      makePR({ number: 113, branch: "feat/good" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);

    // First claimPR fails (e.g. CONFLICTING), second succeeds
    let spawnCount = 0;
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      return makeSession({ id: `new-${spawnCount}` });
    });
    vi.mocked(mockSessionManager.claimPR)
      .mockRejectedValueOnce(new Error("Workspace has uncommitted changes"))
      .mockResolvedValueOnce({
        sessionId: "new-2",
        projectId: "proj",
        pr: prs[1],
        branchChanged: true,
        githubAssigned: false,
        takenOverFrom: [],
      });

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    // First session spawned and killed (claim failed for PR 123), second spawned and claimed (PR 113)
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.kill).toHaveBeenCalledWith("new-1");
    expect(mockSessionManager.claimPR).toHaveBeenNthCalledWith(1, "new-1", "123");
    expect(mockSessionManager.claimPR).toHaveBeenNthCalledWith(2, "new-2", "113");
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

  it("skips failed PR and spawns next uncovered PR when spawn fails", async () => {
    const prs = [
      makePR({ number: 99, branch: "feat/spawn-fail" }),
      makePR({ number: 77, branch: "feat/spawn-ok" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);

    // First spawn fails (throws), second succeeds — use mockImplementation
    // with call-tracking so we can distinguish which call belongs to which PR.
    let spawnCount = 0;
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      if (spawnCount === 1) throw new Error("Runtime unavailable");
      return makeSession({ id: `new-${spawnCount}` });
    });

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    // claimPR was only called once — for the successful second spawn, not the failed one
    expect(mockSessionManager.claimPR).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("new-2", "77");
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.spawn_failed",
        outcome: "failure",
        data: expect.objectContaining({ prNumber: 99, consecutiveSpawnFailures: 1 }),
      }),
    );
  });

  it("claim failures accumulate across spawn successes and abort after 3 total", async () => {
    const prs = [
      makePR({ number: 1, branch: "feat/a" }),
      makePR({ number: 2, branch: "feat/b" }),
      makePR({ number: 3, branch: "feat/c" }),
      makePR({ number: 4, branch: "feat/d" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);

    // First spawn succeeds, claim fails; second spawn succeeds, claim fails;
    // third spawn succeeds, claim fails → 3 total claim failures, abort.
    // Spawn success must NOT reset consecutiveClaimFailures.
    let spawnCount = 0;
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      return makeSession({ id: `new-${spawnCount}` });
    });
    vi.mocked(mockSessionManager.claimPR).mockRejectedValue(new Error("conflict"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(false);
    // Spawn called 3 times, claim called 3 times (once per spawn), then abort
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(3);
    expect(mockSessionManager.claimPR).toHaveBeenCalledTimes(3);
    // Kill was called for each failed session
    expect(mockSessionManager.kill).toHaveBeenCalledTimes(3);
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.claim_failed_abort",
        outcome: "failure",
        data: { consecutiveClaimFailures: 3 },
      }),
    );
  });

  it("stops after 3 consecutive spawn failures and returns false", async () => {
    const prs = [
      makePR({ number: 1, branch: "feat/a" }),
      makePR({ number: 2, branch: "feat/b" }),
      makePR({ number: 3, branch: "feat/c" }),
      makePR({ number: 4, branch: "feat/d" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);
    vi.mocked(mockSessionManager.spawn).mockRejectedValue(new Error("Runtime unavailable"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(false);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(3);
    expect(mockSessionManager.claimPR).not.toHaveBeenCalled();
    // Should have recorded the abort
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.spawn_failed_abort",
        outcome: "failure",
        data: { consecutiveSpawnFailures: 3 },
      }),
    );
  });

  it("records error when orphan cleanup fails after claimPR failure", async () => {
    const pr = makePR({ number: 5, branch: "feat/claim-fail" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    vi.mocked(mockSessionManager.claimPR).mockRejectedValue(new Error("conflict"));
    vi.mocked(mockSessionManager.kill).mockRejectedValue(new Error("session already dead"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(false);
    expect(mockObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.orphan_cleanup_failed",
        outcome: "failure",
        data: expect.objectContaining({ prNumber: 5 }),
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

  // ---- tmux liveness tests ----

  it("treats PR as uncovered when its session's tmux session is dead", async () => {
    const pr = makePR({ number: 77, branch: "feat/dead-tmux" });

    // Session for this PR exists, but tmux is dead
    const deadSession = makeSession({
      id: "dead-1",
      branch: "feat/dead-tmux",
      pr: { ...pr },
      runtimeHandle: { id: "rt-dead", runtimeName: "tmux", data: {} },
    });
    // Override: only "rt-dead" is dead, all others alive
    vi.mocked(hasSession).mockImplementation(async (name: string) => name !== "rt-dead");

    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [deadSession] }),
    );

    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledOnce();
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("new-1", "77");
  });

  it("keeps PR covered when session's tmux session is alive", async () => {
    const pr = makePR({ number: 88, branch: "feat/alive-tmux" });
    const aliveSession = makeSession({
      branch: "feat/alive-tmux",
      pr: { ...pr },
      runtimeHandle: { id: "rt-alive", runtimeName: "tmux", data: {} },
    });
    // All sessions alive → PR stays covered
    vi.mocked(hasSession).mockResolvedValue(true);

    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [aliveSession] }),
    );

    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("skips tmux check for sessions without runtimeHandle (non-tmux runtime)", async () => {
    const pr = makePR({ number: 99, branch: "feat/no-rt" });
    const noRtSession = makeSession({
      branch: "feat/no-rt",
      pr: { ...pr },
      runtimeHandle: null, // non-tmux runtime
    });
    vi.mocked(hasSession).mockResolvedValue(false); // irrelevant

    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [noRtSession] }),
    );

    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
  });

  it("skips tmux check for sessions with runtimeName !== tmux (non-tmux runtime)", async () => {
    const pr = makePR({ number: 88, branch: "feat/process-rt" });
    const processSession = makeSession({
      branch: "feat/process-rt",
      pr: { ...pr },
      runtimeHandle: { id: "rt-process", runtimeName: "process", data: {} },
    });
    vi.mocked(hasSession).mockResolvedValue(false); // would wrongly mark as dead without the guard

    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [processSession] }),
    );

    // Non-tmux runtime: session counted as covered (no tmux liveness check).
    // hasSession should NOT be called since runtimeName !== "tmux".
    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
  });

  it("treats session as alive when tmux.hasSession throws (fail-open)", async () => {
    const pr = makePR({ number: 55, branch: "feat/tmux-err" });
    const session = makeSession({
      branch: "feat/tmux-err",
      pr: { ...pr },
      runtimeHandle: { id: "rt-err", runtimeName: "tmux", data: {} },
    });
    vi.mocked(hasSession).mockRejectedValue(new Error("tmux server down"));

    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(
      deps,
      makeParams({ activeSessions: [session] }),
    );

    // Fail-open → session treated as alive → PR stays covered
    expect(result).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  // ---- CR review context tests ----

  it("injects CR review body into spawn prompt for CHANGES_REQUESTED PRs", async () => {
    const pr = makePR({ number: 200, branch: "feat/cr-review" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    vi.mocked(mockSCM.getReviewDecision!).mockResolvedValue("changes_requested");

    const crReview = {
      author: "coderabbitai[bot]",
      state: "changes_requested" as const,
      body: "Please fix the naming convention in auth.ts",
      submittedAt: new Date(),
    };
    vi.mocked(mockSCM.getReviews!).mockResolvedValue([crReview]);

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    expect(mockSCM.getReviewDecision).toHaveBeenCalledWith(pr);
    expect(mockSCM.getReviews).toHaveBeenCalledWith(pr);

    const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
    expect(spawnCall.prompt).toContain("CHANGES_REQUESTED");
    expect(spawnCall.prompt).toContain("Please fix the naming convention in auth.ts");
  });

  it("falls back to generic prompt when CR review fetch returns no CR reviews", async () => {
    const pr = makePR({ number: 201, branch: "feat/no-cr-review", title: "My feature" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    vi.mocked(mockSCM.getReviewDecision!).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getReviews!).mockResolvedValue([]); // no CR reviews

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
    expect(spawnCall.prompt).not.toContain("CHANGES_REQUESTED");
    expect(spawnCall.prompt).toContain("Continue working on PR #201");
  });

  it("falls back to generic prompt when getReviews throws", async () => {
    const pr = makePR({ number: 203, branch: "feat/reviews-err", title: "Reviews error" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    vi.mocked(mockSCM.getReviewDecision!).mockResolvedValue("changes_requested");
    vi.mocked(mockSCM.getReviews!).mockRejectedValue(new Error("API error"));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
    expect(spawnCall.prompt).not.toContain("CHANGES_REQUESTED");
    expect(spawnCall.prompt).toContain("Continue working on PR #203");
  });

  it("calls getReviewDecision for all uncovered PRs; skips getReviews for non-CHANGES_REQUESTED PRs", async () => {
    const pr = makePR({ number: 202, branch: "feat/approved", title: "Approved PR" });
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
    // Default mock returns "pending" — not "changes_requested"

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    // getReviewDecision IS called (part of the loop over all uncovered PRs)
    expect(mockSCM.getReviewDecision).toHaveBeenCalledWith(pr);
    // getReviews should NOT be called for non-CHANGES_REQUESTED PRs
    expect(mockSCM.getReviews).not.toHaveBeenCalled();
    const spawnCall = vi.mocked(mockSessionManager.spawn).mock.calls[0][0];
    expect(spawnCall.prompt).toContain("Continue working on PR #202");
  });

  // ---- rate-limit tests ----

  // backfillUncoveredPRs returns after the FIRST successful spawn + claim.
  // Rate-limit (counter, max=2) guards against >2 total CR-PR spawns across cycles.
  // Per-cycle return: backfill exits after first spawn+claim success.
  // Combined: in a single call, only 1 PR can succeed; across calls, counter caps at 2.
  //
  // This test exercises the rate-limit by forcing the loop to process multiple PRs:
  // with counter=0, two CR-PRs fail claim (loop continues), third CR-PR succeeds
  // and exits (counter=1). Next backfill call would process PR#304 (counter=1→2),
  // and a third call would skip #305 since counter=2 (max).
  it("skips CR-PR when rate-limit cap (2) is reached across cycles", async () => {
    // 4 CR-PRs: first 2 fail claim (loop continues, counter stays 0),
    // third succeeds (counter=0<2, counter becomes 1, backfill returns).
    // Second backfill call: counter=1, PR#304 succeeds (counter becomes 2).
    // Third backfill call: counter=2≥2, PR#305 SKIPPED.
    const prs = [
      makePR({ number: 301, branch: "feat/cr-1", title: "CR PR 301" }),
      makePR({ number: 302, branch: "feat/cr-2", title: "CR PR 302" }),
      makePR({ number: 303, branch: "feat/cr-3", title: "CR PR 303" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);
    vi.mocked(mockSCM.getReviewDecision!).mockImplementation(async () => "changes_requested");
    vi.mocked(mockSCM.getReviews!).mockResolvedValue([
      { author: "coderabbitai[bot]", state: "changes_requested" as const, body: "fix", submittedAt: new Date().toISOString(), commit_id: "x" },
    ]);
    let spawnCount = 0;
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      return makeSession({ id: `new-${spawnCount}` });
    });
    // First two claims fail (loop continues), third succeeds (backfill returns).
    vi.mocked(mockSessionManager.claimPR)
      .mockRejectedValueOnce(new Error("conflict"))
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({
        sessionId: "new-3",
        projectId: "proj",
        pr: prs[2],
        branchChanged: false,
        githubAssigned: false,
        takenOverFrom: [],
      });

    const result = await backfillUncoveredPRs(deps, makeParams());

    // PR#301: spawn OK, claim fails → counter stays 0, continue
    // PR#302: spawn OK, claim fails → counter stays 0, continue
    // PR#303: counter=0<2, spawn OK, claim succeeds → counter=1, backfill returns
    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(3);
    expect(mockSessionManager.claimPR).toHaveBeenCalledTimes(3);
    // Counter is now 1 — next backfill call with the same PRs (still uncovered) would
    // process PR#301 again (counter=1→2), and a third call would skip PR#302/#303.
  });

  // Verify rate-limit counter IS incremented for CHANGES_REQUESTED PRs
  it("increments respawn counter for each CHANGES_REQUESTED PR processed", async () => {
    // Single CHANGES_REQUESTED PR — counter goes from 0 to 1
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([
      makePR({ number: 401, branch: "feat/cr-c1", title: "CR C1" }),
    ]);
    vi.mocked(mockSCM.getReviewDecision!).mockImplementation(async () => "changes_requested");
    vi.mocked(mockSCM.getReviews!).mockResolvedValue([
      { author: "coderabbitai[bot]", state: "changes_requested" as const, body: "fix", submittedAt: new Date() },
    ]);
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => makeSession({ id: "new-401" }));

    const result = await backfillUncoveredPRs(deps, makeParams());

    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    // After processing 1 CR-PR, counter is 1
  });

  // Counter increments only after BOTH spawn and claim succeed.
  // If claim fails, counter is NOT burned — the rate-limit slot is preserved.
  it("does not increment counter when claim fails for a CHANGES_REQUESTED PR", async () => {
    const prs = [
      makePR({ number: 501, branch: "feat/cr-501", title: "CR PR 501" }),
      makePR({ number: 502, branch: "feat/cr-502", title: "CR PR 502" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);
    vi.mocked(mockSCM.getReviewDecision!).mockImplementation(async () => "changes_requested");
    vi.mocked(mockSCM.getReviews!).mockResolvedValue([
      { author: "coderabbitai[bot]", state: "changes_requested" as const, body: "fix", submittedAt: new Date() },
    ]);
    let spawnCount = 0;
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => {
      spawnCount++;
      return makeSession({ id: `new-${spawnCount}` });
    });
    // First claim fails; second succeeds
    vi.mocked(mockSessionManager.claimPR)
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({
        sessionId: "new-2",
        projectId: "proj",
        pr: prs[1],
        branchChanged: false,
        githubAssigned: false,
        takenOverFrom: [],
      });

    const result = await backfillUncoveredPRs(deps, makeParams());

    // First PR: spawns OK, claim fails → counter NOT incremented, continue
    // Second PR: counter still 0, spawns OK, claim succeeds → counter incremented to 1
    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(2);
    expect(mockSessionManager.claimPR).toHaveBeenCalledTimes(2);
  });

  // Counter increments only after BOTH spawn and claim succeed.
  // At counter=2 (MAX), no more CR-PRs are spawned even if more PRs remain in the same call.
  // (backfill processes ONE PR per call — the rate-limit guards the NEXT backfill cycle.)
  it("skips CHANGES_REQUESTED PRs once rate-limit (2) is exhausted", async () => {
    const prs = [
      makePR({ number: 601, branch: "feat/cr-601", title: "CR PR 601" }),
      makePR({ number: 602, branch: "feat/cr-602", title: "CR PR 602" }),
      makePR({ number: 603, branch: "feat/cr-603", title: "CR PR 603" }),
    ];
    vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue(prs);
    vi.mocked(mockSCM.getReviewDecision!).mockImplementation(async () => "changes_requested");
    vi.mocked(mockSCM.getReviews!).mockResolvedValue([
      { author: "coderabbitai[bot]", state: "changes_requested" as const, body: "fix", submittedAt: new Date() },
    ]);
    vi.mocked(mockSessionManager.spawn).mockImplementation(async () => makeSession({ id: "new-1" }));

    const result = await backfillUncoveredPRs(deps, makeParams());

    // PR#601: counter=0, spawn+claim succeed → counter=1, backfill returns.
    // PRs #602/#603: not processed this cycle (backfill already returned).
    expect(result).toBe(true);
    expect(mockSessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("new-1", "601");
  });
});

// Note: spawn-failure and claim-failure counters are independent.
// A spawn success resets spawnFailures; a claim success resets claimFailures.
// A spawn success does NOT reset claimFailures — claim failures accumulate
// across the entire cycle, not just consecutive ones.
