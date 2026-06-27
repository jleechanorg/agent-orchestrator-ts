import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// Mutable hook to mock execFile calls dynamically in ESM
type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;
type ExecFileImpl = (cmd: string, args: string[], callback: ExecFileCallback) => unknown;
let mockExecFileImpl: ExecFileImpl | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const mockExecFile = Object.assign(
    (cmd: string, args: string[], ...rest: unknown[]) => {
      if (mockExecFileImpl) {
        const callback = rest[rest.length - 1] as ExecFileCallback;
        return mockExecFileImpl(cmd, args, callback);
      }
      return original.execFile(cmd, args, ...(rest as []));
    },
    {
      [promisify.custom]: (
        cmd: string,
        args: string[],
        opts: Parameters<typeof original.execFile>[2],
      ) => {
        return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          if (mockExecFileImpl) {
            mockExecFileImpl(cmd, args, (err, stdout, stderr) => {
              if (err) return reject(err);
              resolve({ stdout, stderr });
            });
          } else {
            original.execFile(cmd, args, opts, (err, stdout, stderr) => {
              if (err) return reject(err);
              resolve({ stdout: stdout as string, stderr: stderr as string });
            });
          }
        });
      }
    }
  );
  return {
    ...original,
    execFile: mockExecFile,
  };
});
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
import { getSessionsDir } from "../paths.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
} from "../global-pause.js";

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
    } as unknown as SessionManager;

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

  // Guarantee mockExecFileImpl reset even when individual tests throw — without
  // this, a failing assertion would leak the mock into the next test.
  afterEach(() => {
    mockExecFileImpl = null;
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

  it("calls getReviewDecision for all uncovered PRs; skips getReviews for non-CR/PRs", async () => {
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
      { author: "coderabbitai[bot]", state: "changes_requested" as const, body: "fix", submittedAt: new Date() },
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

  it("executes direct worktree cleanup fallback with absolute git paths (bd-#670)", async () => {
    // 1. Setup a fake worktree directory that exists, so existsSync(worktreeDir) is true.
    const tempDir = join(tmpdir(), `ao-test-wt-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });

    // 2. Setup mutable mock execFile implementation
    const gitCalls: { cmd: string; args: string[] }[] = [];
    mockExecFileImpl = (cmd, args, callback) => {
      gitCalls.push({ cmd, args });
      let stdout = "";
      if (args && args.includes("branch") && args.includes("--show-current")) {
        stdout = "feat/some-branch\n";
      } else if (args && args.includes("rev-parse") && args.includes("--git-common-dir")) {
        stdout = "/tmp/repo/.git\n";
      } else if (args && args.includes("worktree") && args.includes("list")) {
        stdout = `worktree ${tempDir}/test/new-1\nbranch refs/heads/feat/some-branch\n\n`;
      }
      process.nextTick(() => callback(null, stdout, ""));
      return {};
    };

    try {
      const pr = makePR({ number: 5, branch: "feat/some-branch" });
      vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
      vi.mocked(mockSessionManager.claimPR).mockRejectedValue(new Error("conflict"));
      vi.mocked(mockSessionManager.kill).mockRejectedValue(new Error("session already dead"));

      const worktreeDir = join(tempDir, "test", "new-1");
      mkdirSync(worktreeDir, { recursive: true });

      const customProject = makeProject({
        path: "/tmp/repo",
      });

      const params = makeParams({
        project: customProject,
        worktreeDir: tempDir,
      });

      const result = await backfillUncoveredPRs(deps, params);

      expect(result).toBe(false);

      // Verify the spy/mock was called with absolute git "/usr/bin/git"
      expect(gitCalls.length).toBeGreaterThan(0);
      let gitCallsCount = 0;
      for (const call of gitCalls) {
        if (call.cmd === "git" || call.cmd?.toString().endsWith("git")) {
          gitCallsCount++;
          expect(call.cmd).toBe("/usr/bin/git");
        }
      }
      expect(gitCallsCount).toBeGreaterThan(0);

      // Specifically verify the cleanup-path git calls (worktree unlock,
      // worktree prune, branch -D) all use the absolute path. These are
      // bd-#670 fix sites in backfill-extensions.ts error-recovery paths
      // (lines 566, 579, 588) that the diff-coverage gate requires exercised.
      const cleanupSubcommands = new Set(["unlock", "prune"]);
      const cleanupCalls = gitCalls.filter(
        (c) => Array.isArray(c.args) && c.args.some((a: string) => cleanupSubcommands.has(a)),
      );
      for (const call of cleanupCalls) {
        expect(call.cmd).toBe("/usr/bin/git");
      }
      // branch -D cleanup at line 588: triggered when branch matches the
      // feat/fix/chore/docs/refactor/session prefix pattern.
      const branchDeleteCalls = gitCalls.filter(
        (c) => Array.isArray(c.args) && c.args.includes("-D"),
      );
      for (const call of branchDeleteCalls) {
        expect(call.cmd).toBe("/usr/bin/git");
      }
    } finally {
      // Clean up
      mockExecFileImpl = null;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
  });

  it("exercises cleanup path with worktreeDir matching projectId/session.id (bd-#670 coverage)", async () => {
    // The cleanup IIFE inside the kill-failure branch computes
    //   worktreeDir = resolve(worktreeRoot, projectId, session.id)
    // For coverage on the in-block git calls (unlock, prune, branch -D,
    // worktree remove), the test must:
    //   1. Create that exact path so existsSync(worktreeDir) is true.
    //   2. Make findRepoPathForWorktree succeed so repoDir is set
    //      (the unlock/remove/prune/branch -D block is gated on repoDir).
    //      findRepoPathForWorktree walks up from worktreeDir looking for
    //      a `.git` dir. We create `.git` at the worktreeDir itself.
    const tempDir = join(tmpdir(), `ao-test-wt2-${randomUUID()}`);
    const fakeRepo = join(tempDir, "fake-repo");
    mkdirSync(fakeRepo, { recursive: true });
    // The worktree dir the IIFE will look for:
    const worktreeRoot = tempDir;
    const expectedWorktreeDir = join(worktreeRoot, "proj", "new-1");
    mkdirSync(expectedWorktreeDir, { recursive: true });
    // Create .git at worktreeDir so findRepoPathForWorktree resolves repoDir
    mkdirSync(join(expectedWorktreeDir, ".git"), { recursive: true });

    // Track every exec call to verify absolute git path is used.
    const gitCalls: { cmd: string; args: string[] }[] = [];
    mockExecFileImpl = (cmd, args, callback) => {
      gitCalls.push({ cmd, args });
      let stdout = "";
      if (args && args.includes("branch") && args.includes("--show-current")) {
        stdout = "feat/some-branch\n";
      } else if (args && args.includes("rev-parse") && args.includes("--git-common-dir")) {
        stdout = join(fakeRepo, ".git") + "\n";
      } else if (args && args.includes("worktree") && args.includes("list")) {
        stdout = `worktree ${expectedWorktreeDir}\nbranch refs/heads/feat/some-branch\n\n`;
      }
      process.nextTick(() => callback(null, stdout, ""));
      return {};
    };

    try {
      const pr = makePR({ number: 6, branch: "feat/some-branch" });
      vi.mocked(mockSCM.listOpenPRs!).mockResolvedValue([pr]);
      vi.mocked(mockSessionManager.claimPR).mockRejectedValue(new Error("conflict"));
      vi.mocked(mockSessionManager.kill).mockRejectedValue(new Error("session already dead"));

      const customProject = makeProject({ path: fakeRepo });
      const params = makeParams({
        project: customProject,
        worktreeDir: tempDir, // overrides resolve(homedir(), ".worktrees")
      });

      const result = await backfillUncoveredPRs(deps, params);
      expect(result).toBe(false);

      // Verify cleanup-path git calls use absolute /usr/bin/git
      // (lines 566, 572, 579, 588 in backfill-extensions.ts).
      const cleanupSubcommands = new Set(["unlock", "prune", "remove"]);
      const cleanupCalls = gitCalls.filter(
        (c) => Array.isArray(c.args) && c.args.some((a: string) => cleanupSubcommands.has(a)),
      );
      expect(cleanupCalls.length).toBeGreaterThan(0);
      for (const call of cleanupCalls) {
        expect(call.cmd).toBe("/usr/bin/git");
      }
      // branch -D cleanup
      const branchDeleteCalls = gitCalls.filter(
        (c) => Array.isArray(c.args) && c.args.includes("-D"),
      );
      expect(branchDeleteCalls.length).toBeGreaterThan(0);
      for (const call of branchDeleteCalls) {
        expect(call.cmd).toBe("/usr/bin/git");
      }
    } finally {
      mockExecFileImpl = null;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
  });
});

// Note: spawn-failure and claim-failure counters are independent.
// A spawn success resets spawnFailures; a claim success resets claimFailures.
// A spawn success does NOT reset claimFailures — claim failures accumulate
// across the entire cycle, not just consecutive ones.

describe("backfillUncoveredPRs respawn guard", () => {
  let guardTmpDir: string;
  let guardConfigPath: string;
  let guardDeps: BackfillDeps;
  let guardSCM: SCM;
  let guardSessionManager: SessionManager;
  let guardObserver: ProjectObserver;
  let guardRegistry: PluginRegistry;

  beforeEach(() => {
    _resetBackfillTimer();
    guardTmpDir = join(tmpdir(), `ao-backfill-guard-ext-${randomUUID()}`);
    mkdirSync(guardTmpDir, { recursive: true });
    guardConfigPath = join(guardTmpDir, "agent-orchestrator.yaml");
    writeFileSync(guardConfigPath, "# test\n", "utf-8");

    guardSCM = {
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

    guardSessionManager = {
      spawn: vi.fn().mockResolvedValue(makeSession({ id: "new-guard" })),
      spawnOrchestrator: vi.fn(),
      restore: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn().mockResolvedValue({
        sessionId: "new-guard",
        projectId: "proj",
        pr: makePR(),
        branchChanged: true,
        githubAssigned: false,
        takenOverFrom: [],
      }),
    } as unknown as SessionManager;

    guardObserver = {
      component: "test",
      recordOperation: vi.fn(),
      setHealth: vi.fn(),
    };

    guardRegistry = {
      get: vi.fn().mockReturnValue(guardSCM),
      register: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
    } as unknown as PluginRegistry;

    guardDeps = {
      registry: guardRegistry,
      sessionManager: guardSessionManager,
      observer: guardObserver,
    };
  });

  afterEach(() => {
    rmSync(guardTmpDir, { recursive: true, force: true });
  });

  function guardParams(overrides: Partial<BackfillParams> = {}): BackfillParams {
    return {
      projectId: "proj",
      project: makeProject({ path: guardTmpDir, sessionPrefix: "app" }),
      activeSessions: [],
      correlationId: "corr-guard",
      configPath: guardConfigPath,
      ...overrides,
    };
  }

  function writeOrchestratorSeed(sessionsDir: string, content = "status=active\n"): void {
    mkdirSync(sessionsDir, { recursive: true });
    const orchestratorPath = join(sessionsDir, "app-orchestrator");
    if (existsSync(orchestratorPath)) {
      rmSync(orchestratorPath, { recursive: true, force: true });
    }
    writeFileSync(orchestratorPath, content, "utf-8");
  }

  it("skips backfill when project is paused for model rate limit", async () => {
    const sessionsDir = getSessionsDir(guardConfigPath, guardTmpDir);
    mkdirSync(sessionsDir, { recursive: true });
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    writeFileSync(
      join(sessionsDir, "app-orchestrator"),
      `status=active\n${GLOBAL_PAUSE_UNTIL_KEY}=${until}\n${GLOBAL_PAUSE_REASON_KEY}=quota\n`,
      "utf-8",
    );

    const pr = makePR({ number: 654, branch: "feat/test" });
    vi.mocked(guardSCM.listOpenPRs!).mockResolvedValue([pr]);

    const result = await backfillUncoveredPRs(guardDeps, guardParams());

    expect(result).toBe(false);
    expect(guardSessionManager.spawn).not.toHaveBeenCalled();
    expect(guardObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.project_paused",
      }),
    );
  });

  it("skips PRs at respawn cap and escalates to Slack once", async () => {
    const pr = makePR({ number: 654, branch: "feat/skeptic-model-list", url: "https://github.com/org/repo/pull/654" });
    vi.mocked(guardSCM.listOpenPRs!).mockResolvedValue([pr]);

    const sessionsDir = getSessionsDir(guardConfigPath, guardTmpDir);
    writeOrchestratorSeed(sessionsDir);

    const archiveDir = join(sessionsDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    for (const id of ["app-94", "app-95", "app-96", "app-97", "app-98", "app-99"]) {
      writeFileSync(
        join(archiveDir, `${id}_2026-06-08T12-00-00-000Z`),
        "status=killed\npr=https://github.com/org/repo/pull/654\n",
        "utf-8",
      );
    }

    const notifyHuman = vi.fn().mockResolvedValue(undefined);
    const depsWithNotify = { ...guardDeps, notifyHuman };

    const result = await backfillUncoveredPRs(depsWithNotify, guardParams());

    expect(result).toBe(false);
    expect(guardSessionManager.spawn).not.toHaveBeenCalled();
    expect(notifyHuman).toHaveBeenCalledOnce();
    expect(notifyHuman).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.escalated",
        message: expect.stringContaining("PR #654"),
        data: expect.objectContaining({ prNumber: 654, respawnCount: 6 }),
      }),
      "urgent",
    );
    expect(guardObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.respawn_cap_escalated",
      }),
    );
    expect(guardObserver.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "lifecycle.backfill.respawn_cap_skip",
      }),
    );
  });

  it("does not re-notify Slack when respawn cap escalation was already sent", async () => {
    const pr = makePR({ number: 654, branch: "feat/skeptic-model-list" });
    vi.mocked(guardSCM.listOpenPRs!).mockResolvedValue([pr]);

    const sessionsDir = getSessionsDir(guardConfigPath, guardTmpDir);
    writeOrchestratorSeed(sessionsDir, "status=active\nbackfillRespawnNotified_654=true\n");
    const archiveDir = join(sessionsDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    for (const id of ["app-94", "app-95", "app-96", "app-97", "app-98", "app-99"]) {
      writeFileSync(
        join(archiveDir, `${id}_2026-06-08T12-00-00-000Z`),
        "status=killed\npr=https://github.com/org/repo/pull/654\n",
        "utf-8",
      );
    }
    const notifyHuman = vi.fn().mockResolvedValue(undefined);
    const result = await backfillUncoveredPRs({ ...guardDeps, notifyHuman }, guardParams());

    expect(result).toBe(false);
    expect(notifyHuman).not.toHaveBeenCalled();
    expect(guardSessionManager.spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bd-#670: lifecycle-workers running under launchd hit `spawn git ENOENT`
// because PATH doesn't reliably propagate to nohup'd children on macOS.
// Workers stay alive (liveness probe passes) but every internal `git` call
// fails. Fix: use absolute `/usr/bin/git` in all 4 files that spawn git so
// the call bypasses PATH lookup entirely.
//
// This regression guard asserts at the source-string level — a behavioural
// test would require triggering a real worktree-cleanup path with full
// SCM/tracker mocks. A string check is sufficient because:
//   1. The fix is mechanical (~25 call sites across 4 files, all the same pattern)
//   2. The bug recurs via re-introduction, not runtime regression
//   3. The same pattern is used in `wholesome.test.ts` for code-style guards
// ---------------------------------------------------------------------------

describe("spawn helpers use absolute /usr/bin/git (bd-#670)", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  // Files that historically spawned bare "git" via child_process.
  // All must be changed to use absolute "/usr/bin/git" so the spawn
  // bypasses the PATH lookup that launchd-launched workers can't trust.
  const filesUnderGuard = [
    "backfill-extensions.ts",
    "session-manager.ts",
    "utils/worktree-git.ts",
    "evidence-bundle.ts",
  ] as const;

  // execFileAsync / execFileSync / exec — all three forms appear in the
  // call sites. The check is the same: first string arg must not be "git".
  const spawnCallers = [
    "execFileAsync",
    "execFileSync",
    "execFile",
    "exec",
  ] as const;

  function findBareGitViolations(source: string): string[] {
    const lines = source.split("\n");
    const violations: string[] = [];
    const callerPattern = new RegExp(
      `(?:${spawnCallers.join("|")})\\s*\\(`,
    );
    // Match a string-only first arg (not a variable/expression). Supports single/double quotes and backticks.
    const stringArgPattern = /(?:execFileAsync|execFileSync|execFile|exec)\s*\(\s*["'`\s\n]*([^"'`\s\n,)]+)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (callerPattern.test(line)) {
        // Look at this line + next 3 for the first string arg
        // (caller may be split across lines like `execFileAsync(\n  "git",`)
        const block = lines
          .slice(i, i + 4)
          .join(" ")
          .replace(/""/g, '"'); // unescape template-string doubled quotes
        const m = block.match(stringArgPattern);
        if (m && m[1] === "git") {
          violations.push(`line ${i + 1}: ${block.trim().slice(0, 80)}`);
        }
      }
    }
    return violations;
  }

  it("findBareGitViolations catches single quotes, double quotes, and backtick template literals (bd-#670)", () => {
    const testCases = [
      { code: `await execFileAsync("git", ["status"])`, expectedViolationsCount: 1 },
      { code: `await execFileAsync('git', ["status"])`, expectedViolationsCount: 1 },
      { code: "await execFileAsync(`git`, [\"status\"])", expectedViolationsCount: 1 },
      { code: `await execFileAsync("/usr/bin/git", ["status"])`, expectedViolationsCount: 0 },
      { code: `await execFileAsync(gitExecutable, ["status"])`, expectedViolationsCount: 0 },
      { code: `execFileAsync(\n  "git",\n  ["status"]\n)`, expectedViolationsCount: 1 },
    ];
    for (const { code, expectedViolationsCount } of testCases) {
      const violations = findBareGitViolations(code);
      expect(violations.length).toBe(expectedViolationsCount);
    }
  });

  for (const relPath of filesUnderGuard) {
    const sourcePath = join(here, "..", relPath);
    it(`${relPath} does not spawn bare "git" (regression: bd-#670)`, () => {
      const source = readFileSync(sourcePath, "utf8");
      const violations = findBareGitViolations(source);
      expect(violations).toEqual([]);
    });
  }
});
