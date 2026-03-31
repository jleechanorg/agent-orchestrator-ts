import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runLocalSkepticCron,
  _resetSkepticCronTimer,
  _resetSkepticDedupMap,
  _getLastEvaluatedSha,
} from "../skeptic-cron-local.js";
import type {
  Session,
  PRInfo,
  ProjectConfig,
  PluginRegistry,
  SessionManager,
  SCM,
} from "../types.js";
import type { SkepticReviewResult } from "../skeptic-reviewer.js";
import type { ProjectObserver } from "../observability.js";

// --- Mock runSkepticReview ---
const mockRunSkepticReview = vi.fn<
  [Session, { model?: string; postComment?: boolean }],
  Promise<SkepticReviewResult>
>();
vi.mock("../skeptic-reviewer.js", () => ({
  runSkepticReview: (...args: unknown[]) =>
    mockRunSkepticReview(
      ...(args as [Session, { model?: string; postComment?: boolean }]),
    ),
}));

// --- Factories ---
function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 10,
    url: "https://github.com/acme/app/pull/10",
    title: "feat: widget",
    owner: "acme",
    repo: "app",
    branch: "feat/widget",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    projectId: "proj",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: "/tmp/ws",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    scm: { plugin: "github", repo: "acme/app" },
    ...overrides,
  } as ProjectConfig;
}

function makeDeps() {
  const listOpenPRs = vi.fn<[ProjectConfig], Promise<PRInfo[]>>();
  const getPRHeadSha = vi.fn<(pr: PRInfo) => Promise<string>>();
  const mockSCM: Partial<SCM> = { listOpenPRs, getPRHeadSha };
  const registry = {
    get: vi.fn().mockReturnValue(mockSCM),
  } as unknown as PluginRegistry;
  const sessionManager = {} as SessionManager;
  const observer = {
    recordOperation: vi.fn(),
  } as unknown as ProjectObserver;
  return { registry, sessionManager, observer, listOpenPRs, getPRHeadSha };
}

// --- Tests ---
describe("runLocalSkepticCron", () => {
  beforeEach(() => {
    _resetSkepticCronTimer();
    _resetSkepticDedupMap();
    mockRunSkepticReview.mockReset();
    vi.restoreAllMocks();
  });

  it("evaluates open PRs and returns count", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const pr1 = makePR({ number: 1 });
    const pr2 = makePR({ number: 2 });
    listOpenPRs.mockResolvedValue([pr1, pr2]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-1",
      },
    );

    expect(result).toBe(2);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(2);
  });

  it("skips draft PRs", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs.mockResolvedValue([
      makePR({ number: 1, isDraft: true }),
      makePR({ number: 2 }),
    ]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-1",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });

  it("throttles per project — second call within interval returns 0", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR()]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-1",
    };

    const first = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      params,
    );
    expect(first).toBe(1);

    const second = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      params,
    );
    expect(second).toBe(0);
  });

  it("pending guard deduplicates concurrent calls for same projectId", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR()]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-1",
    };

    // Fire two concurrent calls — only the first should run
    const [first, second] = await Promise.all([
      runLocalSkepticCron({ registry, sessionManager, observer }, params),
      runLocalSkepticCron({ registry, sessionManager, observer }, params),
    ]);

    // One ran, one was deduplicated
    expect(first + second).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });

  it("different projectIds have independent throttles", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR()]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const deps = { registry, sessionManager, observer };

    await runLocalSkepticCron(deps, {
      projectId: "proj-a",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-1",
    });

    // Different project should NOT be throttled
    const result = await runLocalSkepticCron(deps, {
      projectId: "proj-b",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-2",
    });
    expect(result).toBe(1);
  });

  it("does not set throttle on listOpenPRs failure — allows retry", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([makePR()]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-1",
    };

    const first = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      params,
    );
    expect(first).toBe(0);

    // Should NOT be throttled — failure doesn't set the timer
    const second = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      params,
    );
    expect(second).toBe(1);
  });

  it("uses existing session when available instead of synthetic", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const pr = makePR({ number: 42 });
    listOpenPRs.mockResolvedValue([pr]);
    const existingSession = makeSession({
      id: "real-sess",
      pr,
      workspacePath: "/real/path",
    });
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [existingSession],
        correlationId: "c-1",
      },
    );

    expect(mockRunSkepticReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "real-sess", workspacePath: "/real/path" }),
      expect.anything(),
    );
  });

  it("one PR failure does not block other PRs", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs.mockResolvedValue([
      makePR({ number: 1 }),
      makePR({ number: 2 }),
    ]);
    mockRunSkepticReview
      .mockRejectedValueOnce(new Error("LLM timeout"))
      .mockResolvedValueOnce({
        verdict: "PASS",
        modelUsed: "claude",
      } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-1",
      },
    );

    // Only 1 succeeded (second PR), first threw
    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(2);
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skeptic.cron.pr_failed" }),
    );
  });

  it("returns 0 when SCM lacks listOpenPRs", async () => {
    const registry = {
      get: vi.fn().mockReturnValue({}),
    } as unknown as PluginRegistry;
    const observer = {
      recordOperation: vi.fn(),
    } as unknown as ProjectObserver;

    const result = await runLocalSkepticCron(
      { registry, sessionManager: {} as SessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-1",
      },
    );

    expect(result).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SHA-based dedup tests
  // -------------------------------------------------------------------------

  it("stores SHA in dedup map after successful evaluation", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-sha" },
    );

    expect(result).toBe(1);
    expect(_getLastEvaluatedSha("proj", 10)).toBe("sha-abc123");
  });

  it("second call with same SHA is skipped (sha_dedup_skip logged)", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    // First call
    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1" },
    );

    // Reset project-level throttle so second call with same projectId can run
    _resetSkepticCronTimer();
    // Same projectId, same SHA → SHA dedup should skip
    mockRunSkepticReview.mockClear();
    const second = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2" },
    );

    expect(second).toBe(0); // skipped by SHA dedup
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(0);
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skeptic.cron.sha_dedup_skip" }),
    );
  });

  it("different SHA triggers re-evaluation", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    // First call stores sha-abc123
    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1" },
    );

    // Different projectId bypasses throttle; different SHA → no dedup, evaluate
    getPRHeadSha.mockResolvedValue("sha-def456");
    mockRunSkepticReview.mockClear();
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const second = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj-2", project: makeProject(), activeSessions: [], correlationId: "c2" },
    );

    expect(second).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(_getLastEvaluatedSha("proj-2", 10)).toBe("sha-def456");
  });

  it("fail-open: evaluates when getPRHeadSha throws", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockRejectedValue(new Error("network failure"));
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-sha" },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(_getLastEvaluatedSha("proj", 10)).toBeUndefined(); // no SHA stored
    expect(observer.recordOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skeptic.cron.sha_dedup_skip" }),
    );
  });

  it("fail-open: evaluates when SCM has no getPRHeadSha", async () => {
    const listOpenPRs = vi.fn<[ProjectConfig], Promise<PRInfo[]>>();
    const mockSCMWithout: Partial<SCM> = { listOpenPRs };
    const registry = {
      get: vi.fn().mockReturnValue(mockSCMWithout),
    } as unknown as PluginRegistry;
    const observer = { recordOperation: vi.fn() } as unknown as ProjectObserver;
    const sessionManager = {} as SessionManager;
    listOpenPRs.mockResolvedValue([makePR({ number: 10 })]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-sha" },
    );

    expect(result).toBe(1);
    expect(_getLastEvaluatedSha("proj", 10)).toBeUndefined();
  });

  it("different projectId has independent SHA dedup state", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR({ number: 10 })]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj-a", project: makeProject(), activeSessions: [], correlationId: "c1" },
    );

    // Different project with same SHA — should NOT skip (independent cache key)
    mockRunSkepticReview.mockClear();
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj-b", project: makeProject(), activeSessions: [], correlationId: "c2" },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(_getLastEvaluatedSha("proj-b", 10)).toBe("sha-abc123");
    expect(_getLastEvaluatedSha("proj-a", 10)).toBe("sha-abc123"); // also stored for proj-a
  });

  // -------------------------------------------------------------------------
  // Original tests
  // -------------------------------------------------------------------------

  it("returns 0 when no open PRs", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs.mockResolvedValue([]);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-1",
      },
    );

    expect(result).toBe(0);
  });
});
