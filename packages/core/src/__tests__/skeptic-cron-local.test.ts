import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runLocalSkepticCron,
  _resetSkepticCronTimer,
  _resetSkepticDedupMap,
  _getLastEvaluatedSha,
  _getLastEvaluatedAt,
  _getLastVerdict,
  _setFirstSeenNewShaAt,
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
  const listPRComments = vi.fn<
    (
      pr: PRInfo,
    ) => Promise<
      Array<{
        id: number;
        body: string;
        user: { login: string };
        isSkepticTrigger?: boolean;
      }>
    >
  >();

  // Default to returning a trigger comment so existing tests continue to pass
  listPRComments.mockResolvedValue([
    { id: 100, body: "/skeptic", user: { login: "jleechan2015" }, isSkepticTrigger: true }
  ]);

  const mockSCM: Partial<SCM> = { listOpenPRs, getPRHeadSha, listPRComments };
  const registry = {
    get: vi.fn().mockReturnValue(mockSCM),
  } as unknown as PluginRegistry;
  const sessionManager = {} as SessionManager;
  const observer = {
    recordOperation: vi.fn(),
  } as unknown as ProjectObserver;
  return { registry, sessionManager, observer, listOpenPRs, getPRHeadSha, listPRComments };
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

  it("listOpenPRs failure remains retryable when observer recording throws", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    listOpenPRs
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([makePR()]);
    observer.recordOperation = vi.fn(() => {
      throw new Error("observer bomb");
    });
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-list-fail-observer",
    };

    await expect(runLocalSkepticCron(
      { registry, sessionManager, observer },
      params,
    )).resolves.toBe(0);

    const second = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      params,
    );
    expect(second).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
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
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
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
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
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

  it("re-evaluates same SHA from different projectId after first run stores SHA", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
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

  it("same projectId, new SHA triggers re-evaluation (throttle reset)", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
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

    // Reset throttle — same projectId, NEW SHA → should re-evaluate
    _resetSkepticCronTimer();
    getPRHeadSha.mockResolvedValue("sha-def456");
    mockRunSkepticReview.mockClear();
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const second = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2" },
    );

    expect(second).toBe(1); // re-evaluated, not skipped
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(_getLastEvaluatedSha("proj", 10)).toBe("sha-def456"); // updated to new SHA
  });

  it("fail-open: evaluates when getPRHeadSha throws", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
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

  it("throw: runSkepticReview rejection does not store SHA — allows retry", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    // LLM call fails — SHA must NOT be cached so next cycle retries
    mockRunSkepticReview.mockRejectedValue(new Error("LLM timeout"));

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-throw" },
    );

    expect(result).toBe(0); // eval failed, not skipped
    expect(_getLastEvaluatedSha("proj", 10)).toBeUndefined(); // SHA NOT cached
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skeptic.cron.pr_failed" }),
    );
  });

  it("throw then success: rejection skips SHA cache, subsequent run stores SHA", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");

    // First run: LLM call fails — SHA must NOT be cached
    mockRunSkepticReview.mockRejectedValue(new Error("LLM timeout"));
    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-throw-1" },
    );
    expect(_getLastEvaluatedSha("proj", 10)).toBeUndefined(); // SHA NOT cached

    // Second run: LLM succeeds — SHA should now be stored
    _resetSkepticCronTimer();
    mockRunSkepticReview.mockClear();
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-throw-2" },
    );

    expect(result).toBe(1); // re-evaluated, not skipped
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(_getLastEvaluatedSha("proj", 10)).toBe("sha-abc123"); // SHA NOW cached
  });

  it("fail-open: evaluates when SCM has no getPRHeadSha", async () => {
    const listOpenPRs = vi.fn<[ProjectConfig], Promise<PRInfo[]>>();
    const listPRComments = vi.fn().mockResolvedValue([
      { id: 100, body: "/skeptic", user: { login: "jleechan2015" }, isSkepticTrigger: true }
    ]);
    const mockSCMWithout: Partial<SCM> = { listOpenPRs, listPRComments };
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
    const scm = registry.get("scm", "github");
    delete scm.listPRComments;
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
  // Bounded concurrency tests
  // -------------------------------------------------------------------------

  it("runs 5 PRs with no more than maxConcurrentSkepticReviews=3 in flight", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3, 4, 5].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);

    let active = 0;
    let maxObserved = 0;
    mockRunSkepticReview.mockImplementation(
      () => new Promise(resolve => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        setTimeout(() => {
          active--;
          resolve({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult);
        }, 10);
      }),
    );

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-concurrency",
      maxConcurrentSkepticReviews: 3,
    };

    const result = await runLocalSkepticCron({ registry, sessionManager, observer }, params);

    expect(result).toBe(5);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(5);
    expect(maxObserved).toBe(3);
  });

  it("defaults to max 3 concurrent when maxConcurrentSkepticReviews is omitted", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);

    let active = 0;
    let maxObserved = 0;
    mockRunSkepticReview.mockImplementation(
      () => new Promise(resolve => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        setTimeout(() => {
          active--;
          resolve({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult);
        }, 10);
      }),
    );

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-default",
      // no maxConcurrentSkepticReviews — defaults to 3
    };

    const result = await runLocalSkepticCron({ registry, sessionManager, observer }, params);

    expect(result).toBe(9);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(9);
    expect(maxObserved).toBe(3);
  });

  it("one PR failure in a batch does not block remaining batches", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3, 4, 5, 6].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);
    // pr1 fails, rest succeed; with concurrency-3, prs 4-6 are in a second batch
    let callCount = 0;
    mockRunSkepticReview.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((_, r) => setTimeout(() => r(new Error("LLM timeout")), 10));
      }
      return new Promise(res => setTimeout(() => res({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult), 10));
    });

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-batch-fail",
        maxConcurrentSkepticReviews: 3,
      },
    );

    expect(result).toBe(5); // 1 failed, 5 succeeded
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(6);
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "skeptic.cron.pr_failed" }),
    );
  });

  it("custom concurrency limit of 1 is respected — sequential behavior", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);
    let active = 0;
    let maxObserved = 0;
    mockRunSkepticReview.mockImplementation(
      () => new Promise(resolve => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        setTimeout(() => {
          active--;
          resolve({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult);
        }, 10);
      }),
    );

    const params = {
      projectId: "proj",
      project: makeProject(),
      activeSessions: [],
      correlationId: "c-seq",
      maxConcurrentSkepticReviews: 1,
    };

    const result = await runLocalSkepticCron({ registry, sessionManager, observer }, params);

    expect(result).toBe(3);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(3);
    expect(maxObserved).toBe(1);
  });

  it("clamps maxConcurrentSkepticReviews=0 to concurrency 1", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3, 4, 5].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);

    let active = 0;
    let maxObserved = 0;
    mockRunSkepticReview.mockImplementation(
      () => new Promise(resolve => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        setTimeout(() => {
          active--;
          resolve({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult);
        }, 10);
      }),
    );

    // Explicitly pass 0 — normalizeMaxConcurrentSkepticReviews(0) returns Math.max(1, 0) = 1
    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-zero",
        maxConcurrentSkepticReviews: 0,
      },
    );

    expect(result).toBe(5);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(5);
    expect(maxObserved).toBe(1);
  });

  it("falls back to default concurrency for non-finite and negative values", async () => {
    for (const configured of [Number.NaN, Number.POSITIVE_INFINITY, -2]) {
      _resetSkepticCronTimer();
      mockRunSkepticReview.mockReset();

      const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
      const prs = [1, 2, 3, 4, 5].map(n => makePR({ number: n }));
      listOpenPRs.mockResolvedValue(prs);

      let active = 0;
      let maxObserved = 0;
      mockRunSkepticReview.mockImplementation(
        () => new Promise(resolve => {
          active++;
          maxObserved = Math.max(maxObserved, active);
          setTimeout(() => {
            active--;
            resolve({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult);
          }, 10);
        }),
      );

      const result = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        {
          projectId: "proj",
          project: makeProject(),
          activeSessions: [],
          correlationId: `c-${String(configured)}`,
          maxConcurrentSkepticReviews: configured,
        },
      );

      expect(result).toBe(5);
      expect(mockRunSkepticReview).toHaveBeenCalledTimes(5);
      expect(maxObserved).toBeLessThanOrEqual(3);
    }
  });

  it("truncates fractional maxConcurrentSkepticReviews before batching", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3, 4, 5].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);

    let active = 0;
    let maxObserved = 0;
    mockRunSkepticReview.mockImplementation(
      () => new Promise(resolve => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        setTimeout(() => {
          active--;
          resolve({ verdict: "PASS", modelUsed: "codex" } as SkepticReviewResult);
        }, 10);
      }),
    );

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-fractional",
        maxConcurrentSkepticReviews: 2.9,
      },
    );

    expect(result).toBe(5);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(5);
    expect(maxObserved).toBe(2);
  });

  it("observer throw in one PR does not cancel rest of batch", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const prs = [1, 2, 3].map(n => makePR({ number: n }));
    listOpenPRs.mockResolvedValue(prs);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "codex",
    } as SkepticReviewResult);

    // Only the first observer call throws; the PR still runs because telemetry
    // failures must not change skeptic evaluation results.
    let observerCalls = 0;
    observer.recordOperation = vi.fn(() => {
      if (observerCalls === 0) { observerCalls++; throw new Error("observer bomb"); }
      observerCalls++;
    });

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-settled",
        maxConcurrentSkepticReviews: 3,
      },
    );

    expect(result).toBe(3);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(3);
  });

  it("caches head SHA when post-review observer recording throws", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR({ number: 10 })]);
    getPRHeadSha.mockResolvedValue("sha-observer-throws");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "codex",
    } as SkepticReviewResult);

    observer.recordOperation = vi.fn(operation => {
      if (operation.operation === "skeptic.cron.evaluated") {
        throw new Error("observer bomb");
      }
    });

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-observer-cache",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(_getLastEvaluatedSha("proj", 10)).toBe("sha-observer-throws");
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

  it("skips PRs without any trigger comments", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: oldDate })]);

    listPRComments.mockResolvedValue([
      { id: 101, body: "just a normal comment", user: { login: "alice" }, isSkepticTrigger: false }
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
        correlationId: "c-no-trigger",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  it("evaluates PRs with SKEPTIC_GATE_TRIGGER comment", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR({ number: 1 })]);
    listPRComments.mockResolvedValue([
      { id: 101, body: "SKEPTIC_GATE_TRIGGER\n<!-- skeptic-gate-trigger-sha -->", user: { login: "github-actions[bot]" }, isSkepticTrigger: true }
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
        correlationId: "c-gate-trigger",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });

  it("evaluates PRs with SKEPTIC_CRON_TRIGGER comment", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR({ number: 1 })]);
    listPRComments.mockResolvedValue([
      { id: 101, body: "SKEPTIC_CRON_TRIGGER\n<!-- skeptic-cron-trigger-sha -->", user: { login: "github-actions[bot]" }, isSkepticTrigger: true }
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
        correlationId: "c-cron-trigger",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });

  it("skips PRs if the trigger comment is posted by a bot but is just /skeptic", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: oldDate })]);
    listPRComments.mockResolvedValue([
      // SCM plugin would NOT set isSkepticTrigger: true for a bot /skeptic
      { id: 101, body: "/skeptic", user: { login: "some-bot[bot]" }, isSkepticTrigger: false }
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
        correlationId: "c-bot-skeptic",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  // ZFC regression: even when a comment body literally contains the trigger
  // keywords, application code must NOT match on the body. Trigger detection
  // is the SCM plugin's responsibility and is consumed via the structured
  // `isSkepticTrigger` flag.
  it("ignores trigger-looking body text when isSkepticTrigger is not set", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: oldDate })]);
    listPRComments.mockResolvedValue([
      // Body matches the legacy heuristic, but the structured flag is false.
      // The cron must skip this PR — the SCM plugin decided it is not a trigger.
      { id: 201, body: "SKEPTIC_GATE_TRIGGER\n<!-- stale marker -->", user: { login: "github-actions[bot]" }, isSkepticTrigger: false },
      { id: 202, body: "/skeptic run please", user: { login: "jleechan2015" }, isSkepticTrigger: false },
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
        correlationId: "c-zfc-regression",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  it("honors a non-bot comment when the SCM plugin marks it as a trigger", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    listOpenPRs.mockResolvedValue([makePR({ number: 1 })]);
    listPRComments.mockResolvedValue([
      { id: 301, body: "/skeptic", user: { login: "jleechan2015" }, isSkepticTrigger: true },
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
        correlationId: "c-struct-flag",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });

  it("skips PRs modified more than 24 hours ago", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    listPRComments.mockResolvedValue([]);
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: oldDate })]);
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
        correlationId: "c-old-pr",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  it("evaluates PRs modified more than 24 hours ago if they have a trigger comment", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: oldDate })]);
    listPRComments.mockResolvedValue([
      { id: 100, body: "/skeptic", user: { login: "jleechan2015" }, isSkepticTrigger: true }
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
        correlationId: "c-old-pr-with-trigger",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });


  it("evaluates PRs modified within the last 24 hours", async () => {
    const { registry, sessionManager, observer, listOpenPRs } = makeDeps();
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: recentDate })]);
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
        correlationId: "c-recent-pr",
      },
    );

    expect(result).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
  });

  it("skips runSkepticReview if listPRComments rejects", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: oldDate })]);
    listPRComments.mockRejectedValue(new Error("boom"));

    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-boom",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
    expect(observer.recordOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "lifecycle_poll",
        operation: "skeptic.cron.list_pr_comments_failed",
        outcome: "failure",
        projectId: "proj",
        correlationId: "c-boom",
        data: expect.objectContaining({
          prNumber: 1,
          error: "boom",
        }),
      }),
    );
  });

  it("skips PRs modified within the last 24 hours if they have no trigger comment", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    listPRComments.mockResolvedValue([]);
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    listOpenPRs.mockResolvedValue([makePR({ number: 1, updatedAt: recentDate })]);
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
        correlationId: "c-recent-pr-no-trigger",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  it("does not call listPRComments for PRs if updatedAt has not changed since successful evaluation (performance optimization)", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments, getPRHeadSha } = makeDeps();
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const pr = makePR({ number: 1, updatedAt: recentDate });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    // Run once to evaluate and cache the SHA
    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-first",
      },
    );

    // Reset throttle and mock counts
    _resetSkepticCronTimer();
    listPRComments.mockClear();
    mockRunSkepticReview.mockClear();

    // Run again with same SHA
    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-second",
      },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
    expect(listPRComments).not.toHaveBeenCalled();
  });

  it("does not call listPRComments if PR updatedAt has not changed since last check (performance optimization)", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments } = makeDeps();
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const pr = makePR({ number: 1, updatedAt: recentDate });
    listOpenPRs.mockResolvedValue([pr]);
    // Mock comments return empty (no trigger)
    listPRComments.mockResolvedValue([]);
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    // Run once — should fetch comments, find no trigger, and skip
    const firstResult = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-first",
      },
    );
    expect(firstResult).toBe(0);
    expect(listPRComments).toHaveBeenCalledTimes(1);

    // Reset throttle and mock counts
    _resetSkepticCronTimer();
    listPRComments.mockClear();
    mockRunSkepticReview.mockClear();

    // Run again with same updatedAt
    const secondResult = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-second",
      },
    );

    // Should skip immediately without fetching comments again
    expect(secondResult).toBe(0);
    expect(listPRComments).not.toHaveBeenCalled();
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  it("retries evaluations on next run if runSkepticReview fails (transient failure resilience)", async () => {
    const { registry, sessionManager, observer, listOpenPRs, listPRComments, getPRHeadSha } = makeDeps();
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const pr = makePR({ number: 1, updatedAt: recentDate });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    // Mock comments return a trigger
    listPRComments.mockResolvedValue([
      { id: 100, body: "/skeptic", user: { login: "jleechan2015" }, isSkepticTrigger: true }
    ]);

    // First run fails transiently
    mockRunSkepticReview.mockRejectedValueOnce(new Error("Transient LLM error"));

    const firstResult = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-first",
      },
    );
    expect(firstResult).toBe(0); // failed
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);

    // Reset throttle and mock counts
    _resetSkepticCronTimer();
    mockRunSkepticReview.mockClear();
    listPRComments.mockClear();

    // Second run succeeds
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    const secondResult = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      {
        projectId: "proj",
        project: makeProject(),
        activeSessions: [],
        correlationId: "c-second",
      },
    );

    // Should retry and succeed
    expect(secondResult).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    expect(listPRComments).toHaveBeenCalledTimes(1);
  });

  it("does not bypass SHA cache check even when a valid trigger comment is present to avoid infinite re-evaluation loops", async () => {
    const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeDeps();
    const pr = makePR({ number: 10 });
    listOpenPRs.mockResolvedValue([pr]);
    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    // Run once to evaluate and cache the SHA
    await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1" },
    );

    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);

    // Reset throttle and clear mock history
    _resetSkepticCronTimer();
    mockRunSkepticReview.mockClear();

    // Run again with same SHA but we have a trigger comment.
    // It should check SHA cache first, find it already evaluated, and skip!
    const result = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2" },
    );

    expect(result).toBe(0);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(0);
  });

  it("falls back to 24h PR age check if listPRComments is missing", async () => {
    const listOpenPRs = vi.fn<[ProjectConfig], Promise<PRInfo[]>>();
    const getPRHeadSha = vi.fn<(pr: PRInfo) => Promise<string>>();
    // SCM has NO listPRComments
    const mockSCMWithout: Partial<SCM> = { listOpenPRs, getPRHeadSha };
    const registry = {
      get: vi.fn().mockReturnValue(mockSCMWithout),
    } as unknown as PluginRegistry;
    const observer = { recordOperation: vi.fn() } as unknown as ProjectObserver;
    const sessionManager = {} as SessionManager;

    getPRHeadSha.mockResolvedValue("sha-abc123");
    mockRunSkepticReview.mockResolvedValue({
      verdict: "PASS",
      modelUsed: "claude",
    } as SkepticReviewResult);

    // 1. PR is recent (< 24h)
    const recentDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const prRecent = makePR({ number: 10, updatedAt: recentDate });
    listOpenPRs.mockResolvedValue([prRecent]);

    const resultRecent = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-recent" },
    );
    expect(resultRecent).toBe(1);
    expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);

    // Reset throttle and clear mock history
    _resetSkepticCronTimer();
    mockRunSkepticReview.mockClear();

    // 2. PR is stale (> 24h)
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const prStale = makePR({ number: 11, updatedAt: staleDate });
    listOpenPRs.mockResolvedValue([prStale]);

    const resultStale = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-stale" },
    );
    expect(resultStale).toBe(0);
    expect(mockRunSkepticReview).not.toHaveBeenCalled();
  });

  it("caches stale PR updatedAt in fallback path to skip subsequent checks", async () => {
    const listOpenPRs = vi.fn<[ProjectConfig], Promise<PRInfo[]>>();
    const getPRHeadSha = vi.fn<(pr: PRInfo) => Promise<string>>();
    const mockSCMWithout: Partial<SCM> = { listOpenPRs, getPRHeadSha };
    const registry = {
      get: vi.fn().mockReturnValue(mockSCMWithout),
    } as unknown as PluginRegistry;
    const observer = { recordOperation: vi.fn() } as unknown as ProjectObserver;
    const sessionManager = {} as SessionManager;

    getPRHeadSha.mockResolvedValue("sha-abc123");

    // PR is stale (> 24h)
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const prStale = makePR({ number: 12, updatedAt: staleDate });
    listOpenPRs.mockResolvedValue([prStale]);

    // First run: evaluates, skips because stale, and caches the updatedAt
    const result1 = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-stale-1" },
    );
    expect(result1).toBe(0);
    expect(getPRHeadSha).toHaveBeenCalledTimes(1);

    // Reset throttle and clear mock history
    _resetSkepticCronTimer();
    getPRHeadSha.mockClear();

    // Second run: should hit lastCheckedUpdatedAtByPR cache and exit immediately without calling getPRHeadSha
    const result2 = await runLocalSkepticCron(
      { registry, sessionManager, observer },
      { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c-stale-2" },
    );
    expect(result2).toBe(0);
    expect(getPRHeadSha).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Per-PR throttle layers (A: time cooldown, B: SHA stability, C: verdict
  // cooldown). All three are gated behind `enablePerPrThrottle: true` so
  // the legacy cadence is preserved by default.
  // -------------------------------------------------------------------------

  describe("enablePerPrThrottle layers", () => {
    /**
     * Each test disables `listPRComments` (the only fallback to the SHA
     * dedup at the end of the chain is the 24h age check) by deleting it
     * from the mock SCM. We do this so the tests focus purely on the
     * per-PR throttle layers and not the trigger-comment flow.
     */
    function makeThrottleDeps() {
      const d = makeDeps();
      const scm = d.registry.get("scm", "github");
      delete scm.listPRComments;
      return d;
    }

    /**
     * Pre-seed the SHA-stability first-seen timestamp to a stale time so
     * Layer B does not skip the very first call (which is the natural
     * behaviour for a brand-new SHA). Tests that want the first call to
     * actually evaluate call this once at the start.
     */
    function preSeedLayerBStale(projectId: string, prNumber: number) {
      _setFirstSeenNewShaAt(projectId, prNumber, Date.now() - 120_000);
    }

    it("Layer A: re-evaluating same PR within perPrCooldownMs is skipped", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeThrottleDeps();
      const pr = makePR({ number: 100 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-A");
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      // Pre-seed Layer B so the first call doesn't first-seen-skip
      preSeedLayerBStale("proj", 100);

      // First evaluation succeeds
      const first = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, perPrCooldownMs: 30 * 60_000, shaStabilityWindowMs: 0 },
      );
      expect(first).toBe(1);
      expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);

      // Reset project throttle; same SHA (within cache) → SHA dedup would
      // already skip. Use a new SHA to test Layer A specifically.
      _resetSkepticCronTimer();
      getPRHeadSha.mockResolvedValue("sha-B");
      preSeedLayerBStale("proj", 100);
      mockRunSkepticReview.mockClear();
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2", enablePerPrThrottle: true, perPrCooldownMs: 30 * 60_000, shaStabilityWindowMs: 0 },
      );

      expect(second).toBe(0); // skipped by Layer A
      expect(mockRunSkepticReview).not.toHaveBeenCalled();
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "skeptic.cron.per_pr_cooldown_skip" }),
      );
    });

    it("Layer A: re-evaluation proceeds after perPrCooldownMs elapses", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeThrottleDeps();
      const pr = makePR({ number: 100 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-X");
      mockRunSkepticReview.mockResolvedValue({
        verdict: "PASS",
        modelUsed: "claude",
      } as SkepticReviewResult);

      preSeedLayerBStale("proj", 100);
      // First evaluation
      await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, perPrCooldownMs: 50, shaStabilityWindowMs: 0 },
      );
      expect(_getLastEvaluatedAt("proj", 100)).toBeDefined();

      // Wait past the cooldown and re-evaluate with a new SHA
      _resetSkepticCronTimer();
      await new Promise(r => setTimeout(r, 75));
      getPRHeadSha.mockResolvedValue("sha-Y");
      preSeedLayerBStale("proj", 100);
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2", enablePerPrThrottle: true, perPrCooldownMs: 50, shaStabilityWindowMs: 0 },
      );

      expect(second).toBe(1); // not skipped
    });

    it("Layer B: new SHA records first-seen and skips first cycle", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeThrottleDeps();
      const pr = makePR({ number: 100 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-1");
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      // First call with a brand-new SHA — Layer B records first-seen and skips
      const first = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, shaStabilityWindowMs: 60_000 },
      );
      expect(first).toBe(0);
      expect(mockRunSkepticReview).not.toHaveBeenCalled();
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "skeptic.cron.sha_first_seen" }),
      );
    });

    it("Layer B: stability window elapses, next cycle evaluates", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeThrottleDeps();
      const pr = makePR({ number: 100 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-1");
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      // First cycle: sha-1 first-seen, skip
      await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, shaStabilityWindowMs: 50 },
      );
      expect(mockRunSkepticReview).not.toHaveBeenCalled();

      // Simulate the first-seen timestamp being stale (window elapsed)
      _setFirstSeenNewShaAt("proj", 100, Date.now() - 120_000);
      _resetSkepticCronTimer();
      mockRunSkepticReview.mockClear();
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2", enablePerPrThrottle: true, shaStabilityWindowMs: 50 },
      );
      // The Layer B check passes (stale first-seen), then SHA dedup kicks in
      // (sha-1 not in lastEvaluatedShaByPR because the first call was skipped),
      // so evaluation runs.
      expect(second).toBe(1);
      expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    });

    it("Layer C: prior FAIL with no new review activity is skipped", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha, listPRComments } = makeDeps();
      // listPRComments is required for Layer C
      const pr = makePR({ number: 200 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-1");
      listPRComments.mockResolvedValue([
        { id: 1, body: "SKEPTIC_CRON_TRIGGER", user: { login: "jleechan2015", type: "User" }, isSkepticTrigger: true },
        { id: 2, body: "Please fix the missing evidence", user: { login: "coderabbitai[bot]", type: "Bot" } },
      ]);
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      // Pre-seed Layer B to allow first-call evaluation
      preSeedLayerBStale("proj", 200);

      // First evaluation succeeds, FAIL recorded
      const first = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, perPrCooldownMs: 0, shaStabilityWindowMs: 0 },
      );
      expect(first).toBe(1);
      expect(_getLastVerdict("proj", 200)).toBe("FAIL");

      // Second call: new SHA, no new comments, last verdict FAIL → Layer C skips
      _resetSkepticCronTimer();
      getPRHeadSha.mockResolvedValue("sha-2");
      preSeedLayerBStale("proj", 200);
      mockRunSkepticReview.mockClear();
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2", enablePerPrThrottle: true, perPrCooldownMs: 0, shaStabilityWindowMs: 0 },
      );

      expect(second).toBe(0); // skipped by Layer C
      expect(mockRunSkepticReview).not.toHaveBeenCalled();
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "skeptic.cron.verdict_cooldown_skip" }),
      );
    });

    it("Layer C: new review activity (new non-bot comment) breaks the cooldown", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha, listPRComments } = makeDeps();
      const pr = makePR({ number: 201 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-1");
      listPRComments.mockResolvedValueOnce([
        { id: 1, body: "SKEPTIC_CRON_TRIGGER", user: { login: "jleechan2015", type: "User" }, isSkepticTrigger: true },
        { id: 2, body: "fix this", user: { login: "coderabbitai[bot]", type: "Bot" } },
      ]).mockResolvedValueOnce([
        { id: 1, body: "SKEPTIC_CRON_TRIGGER", user: { login: "jleechan2015", type: "User" }, isSkepticTrigger: true },
        { id: 2, body: "fix this", user: { login: "coderabbitai[bot]", type: "Bot" } },
        { id: 3, body: "I addressed the issues", user: { login: "jleechan2015", type: "User" } },
      ]);
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      preSeedLayerBStale("proj", 201);
      // First evaluation FAIL
      await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, perPrCooldownMs: 0, shaStabilityWindowMs: 0 },
      );
      expect(_getLastVerdict("proj", 201)).toBe("FAIL");

      // Second call: new SHA, NEW non-bot comment → Layer C does NOT skip
      _resetSkepticCronTimer();
      preSeedLayerBStale("proj", 201);
      getPRHeadSha.mockResolvedValue("sha-2");
      mockRunSkepticReview.mockClear();
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2", enablePerPrThrottle: true, perPrCooldownMs: 0, shaStabilityWindowMs: 0 },
      );

      expect(second).toBe(1); // not skipped
      expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    });

    it("Layer C: prior FAIL with only skeptic verdict posted (no developer activity) is still skipped", async () => {
      // Regression: when the prior FAIL was recorded, the verdict comment
      // was posted by `github-actions[bot]` (logged in as the SKEPTIC_BOT_AUTHOR)
      // and contains `<!-- skeptic-agent-verdict -->`. On the next cron pass,
      // that verdict shows up in the comment list. If `countNonBotComments`
      // doesn't filter it out, the count would appear to have grown and Layer C
      // would treat the verdict as "new review activity" — defeating the cooldown.
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha, listPRComments } = makeDeps();
      const pr = makePR({ number: 202 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-1");
      // First call: only the trigger comment present (count = 0 non-bot)
      listPRComments.mockResolvedValueOnce([
        { id: 1, body: "/skeptic", user: { login: "jleechan2015", type: "User" }, isSkepticTrigger: true },
      ]).mockResolvedValueOnce([
        // Second call: trigger + the FAIL verdict we just posted.
        // The verdict is from `github-actions[bot]` AND contains the
        // skeptic-agent-verdict marker; it must be filtered out.
        { id: 1, body: "/skeptic", user: { login: "jleechan2015", type: "User" }, isSkepticTrigger: true },
        { id: 2, body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL\n...", user: { login: "github-actions[bot]", type: "Bot" } },
        { id: 3, body: "<!-- skeptic-cron-trigger-d682809 -->\nSKEPTIC_GATE_TRIGGER", user: { login: "github-actions[bot]", type: "Bot" } },
      ]);
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      preSeedLayerBStale("proj", 202);
      const first = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1", enablePerPrThrottle: true, perPrCooldownMs: 0, shaStabilityWindowMs: 0 },
      );
      expect(first).toBe(1);
      expect(_getLastVerdict("proj", 202)).toBe("FAIL");

      // Second call: new SHA, only the verdict (no developer activity) → Layer C skips
      _resetSkepticCronTimer();
      getPRHeadSha.mockResolvedValue("sha-2");
      preSeedLayerBStale("proj", 202);
      mockRunSkepticReview.mockClear();
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2", enablePerPrThrottle: true, perPrCooldownMs: 0, shaStabilityWindowMs: 0 },
      );

      expect(second).toBe(0); // skipped — verdict comment does not count as activity
      expect(mockRunSkepticReview).not.toHaveBeenCalled();
      expect(observer.recordOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "skeptic.cron.verdict_cooldown_skip" }),
      );
    });

    it("legacy cadence preserved when enablePerPrThrottle is false (default)", async () => {
      const { registry, sessionManager, observer, listOpenPRs, getPRHeadSha } = makeThrottleDeps();
      const pr = makePR({ number: 300 });
      listOpenPRs.mockResolvedValue([pr]);
      getPRHeadSha.mockResolvedValue("sha-A");
      mockRunSkepticReview.mockResolvedValue({
        verdict: "FAIL",
        modelUsed: "claude",
      } as SkepticReviewResult);

      // Default cadence (no flag) — same as before
      const first = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c1" },
      );
      expect(first).toBe(1);
      expect(_getLastEvaluatedAt("proj", 300)).toBeUndefined();

      // Second call: new SHA, no throttle → evaluates (legacy cadence)
      _resetSkepticCronTimer();
      getPRHeadSha.mockResolvedValue("sha-B");
      mockRunSkepticReview.mockClear();
      const second = await runLocalSkepticCron(
        { registry, sessionManager, observer },
        { projectId: "proj", project: makeProject(), activeSessions: [], correlationId: "c2" },
      );
      expect(second).toBe(1);
      expect(mockRunSkepticReview).toHaveBeenCalledTimes(1);
    });
  });
});

