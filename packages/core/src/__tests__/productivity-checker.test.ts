/**
 * Unit tests for productivity-checker.ts
 *
 * Mock strategy: ghRest is injected via ProductivityDeps.ghRest.
 * No subprocess mocking needed — tests pass a fake ghRest directly.
 * Date.now() is controlled via vi.useFakeTimers() + vi.setSystemTime().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type ProductivityDeps, checkMergedPRCleanup, checkStallDetection, checkContextExhaustion, runProductivityChecks } from "../productivity-checker.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type GhRestMock = (owner: string, repo: string, path: string) => Promise<unknown>;

// Fixed epoch for deterministic fake timers
const NOW_MS = 1_741_000_000_000;
const recentCommitDate = new Date(NOW_MS - 60_000).toISOString();
const oldCommitDate = new Date(NOW_MS - (60 * 60_1000) - 60_000).toISOString();

function makeDeps(
  overrides: Partial<ProductivityDeps> & { ghRest?: GhRestMock } = {},
): ProductivityDeps {
  return {
    config: {} as any,
    sessionManager: {} as any,
    capturePane: vi.fn().mockResolvedValue(""),
    killSession: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    ghRest: async () => null,
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}): import("../types.js").Session {
  return {
    id: "test-session-1",
    projectId: "agent-orchestrator",
    status: "pr_open",
    createdAt: new Date(),
    metadata: {},
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// checkMergedPRCleanup
// ---------------------------------------------------------------------------

describe("checkMergedPRCleanup", () => {
  it("returns skipped when session has no PR metadata", async () => {
    const result = await checkMergedPRCleanup(makeSession(), makeDeps());
    expect(result).toBe("skipped");
  });

  it("returns skipped when session has no PR", async () => {
    // session.pr is null — no PR to check
    const result = await checkMergedPRCleanup(makeSession(), makeDeps());
    expect(result).toBe("skipped");
  });

  it("returns skipped when PR is open", async () => {
    const deps = makeDeps({ ghRest: async () => ({ state: "open", merged: false }) });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { },
    });
    const result = await checkMergedPRCleanup(session, deps);
    expect(result).toBe("skipped");
  });

  it("returns killed and kills tmux session when PR is merged", async () => {
    const killSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      ghRest: async () => ({ state: "closed", merged: true }),
      killSession,
    });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });
    const result = await checkMergedPRCleanup(session, deps);
    expect(result).toBe("killed");
    expect(killSession).toHaveBeenCalledWith("jc-1");
  });

  it("returns killed when PR state is closed (not merged)", async () => {
    const killSession = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      ghRest: async () => ({ state: "closed", merged: false }),
      killSession,
    });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });
    const result = await checkMergedPRCleanup(session, deps);
    expect(result).toBe("killed");
    expect(killSession).toHaveBeenCalledWith("jc-1");
  });

  it("handles ghRest error gracefully", async () => {
    const deps = makeDeps({ ghRest: async () => { throw new Error("network error"); } });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { },
    });
    const result = await checkMergedPRCleanup(session, deps);
    expect(result).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// checkStallDetection
// ---------------------------------------------------------------------------

describe("checkStallDetection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns none when session has no PR metadata", async () => {
    const result = await checkStallDetection(makeSession(), makeDeps());
    expect(result).toBe("none");
  });

  it("returns none when commit is recent (<30 min)", async () => {
    const deps = makeDeps({
      ghRest: async (_o, _r, path: string) => {
        if (path.includes("/commits")) return [{ commit: { committer: { date: recentCommitDate } } }];
        if (path.includes("/status")) return { state: "pending" };
        if (path.includes("/reviews")) return [];
        return { state: "open", merged: false, head: { sha: "abc", ref: "feat/x" }, html_url: "https://x" };
      },
    });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("none");
  });

  it("returns nudged when commit is old and PR not green", async () => {
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      ghRest: async (_o, _r, path: string) => {
        if (path.includes("/commits")) return [{ commit: { committer: { date: oldCommitDate } } }];
        if (path.includes("/status")) return { state: "failure" };
        if (path.includes("/reviews")) return [{ user: { login: "coderabbitai[bot]" }, state: "CHANGES_REQUESTED", submitted_at: new Date(NOW_MS).toISOString() }];
        return { state: "open", merged: false, head: { sha: "abc", ref: "feat/x" }, html_url: "https://github.com/test/pull/123" };
      },
      sendKeys,
    });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("nudged");
    expect(sendKeys).toHaveBeenCalled();
    const nudgeText = sendKeys.mock.calls[0]![1] as string;
    expect(nudgeText).toContain("PR #123");
    expect(nudgeText).toContain("no new commits");
    expect(nudgeText).toContain("CI: failure");
    expect(nudgeText).toContain("CR state: CHANGES_REQUESTED");
  });

  it("returns none when PR is green even with old commit", async () => {
    const sendKeys = vi.fn();
    const deps = makeDeps({
      ghRest: async (_o, _r, path: string) => {
        if (path.includes("/commits")) return [{ commit: { committer: { date: oldCommitDate } } }];
        if (path.includes("/status")) return { state: "success" };
        if (path.includes("/reviews")) return [{ user: { login: "coderabbitai[bot]" }, state: "APPROVED", submitted_at: new Date(NOW_MS).toISOString() }];
        return { state: "open", merged: false, head: { sha: "abc", ref: "feat/x" }, html_url: "https://x" };
      },
      sendKeys,
    });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("none");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("returns none when PR is merged", async () => {
    const deps = makeDeps({
      ghRest: async (_o, _r, path: string) => {
        if (path.includes("/commits")) return [{ commit: { committer: { date: oldCommitDate } } }];
        if (path.includes("/status")) return { state: "failure" };
        if (path.includes("/reviews")) return [];
        return { state: "closed", merged: true, head: { sha: "abc", ref: "feat/x" }, html_url: "https://x" };
      },
    });
    const session = makeSession({
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("none");
  });

  it("returns none when session is in terminal status", async () => {
    const deps = makeDeps({ ghRest: async () => { throw new Error("should not be called"); } });
    const session = makeSession({ status: "killed" });
    const result = await checkStallDetection(session, deps);
    expect(result).toBe("none");
  });

  it("nudge cooldown: second nudge within 60 min returns none", async () => {
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      ghRest: async (_o, _r, path: string) => {
        if (path.includes("/commits")) return [{ commit: { committer: { date: oldCommitDate } } }];
        if (path.includes("/status")) return { state: "failure" };
        if (path.includes("/reviews")) return [];
        return { state: "open", merged: false, head: { sha: "abc", ref: "feat/x" }, html_url: "https://x" };
      },
      sendKeys,
    });
    const session = makeSession({
      id: "cooldown-test",
      pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
    });

    const result1 = await checkStallDetection(session, deps);
    expect(result1).toBe("nudged");

    const result2 = await checkStallDetection(session, deps);
    expect(result2).toBe("none"); // cooldown active — Date.now() shows < 60min elapsed
  });
});

// ---------------------------------------------------------------------------
// checkContextExhaustion
// ---------------------------------------------------------------------------

describe("checkContextExhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns none when pane has no context percentage", async () => {
    const deps = makeDeps({ capturePane: vi.fn().mockResolvedValue("some random output") });
    const session = makeSession({ metadata: { tmuxName: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("none");
  });

  it("returns none when context >5%", async () => {
    const deps = makeDeps({ capturePane: vi.fn().mockResolvedValue("80% until auto-compact") });
    const session = makeSession({ metadata: { tmuxName: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("none");
  });

  it("returns nudged when context <5%", async () => {
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      capturePane: vi.fn().mockResolvedValue("3% until auto-compact is needed"),
      sendKeys,
    });
    const session = makeSession({ metadata: { tmuxName: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("nudged");
    expect(sendKeys).toHaveBeenCalledWith("jc-1", expect.stringContaining("3% remaining"));
  });

  it("returns none when session has no tmuxSession", async () => {
    const session = makeSession({ metadata: {} });
    const result = await checkContextExhaustion(session, makeDeps());
    expect(result).toBe("none");
  });

  it("returns none when capturePane throws", async () => {
    const deps = makeDeps({ capturePane: vi.fn().mockRejectedValue(new Error("capture failed")) });
    const session = makeSession({ metadata: { tmuxName: "jc-1" } });
    const result = await checkContextExhaustion(session, deps);
    expect(result).toBe("none");
  });

  it("returns none when session is in terminal status", async () => {
    const session = makeSession({ status: "killed", metadata: { tmuxName: "jc-1" } });
    const result = await checkContextExhaustion(session, makeDeps());
    expect(result).toBe("none");
  });

  it("cooldown: second nudge within 60 min returns none", async () => {
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      capturePane: vi.fn().mockResolvedValue("3% until auto-compact"),
      sendKeys,
    });
    const session = makeSession({ id: "ctx-cooldown", metadata: { tmuxName: "jc-1" } });

    const result1 = await checkContextExhaustion(session, deps);
    expect(result1).toBe("nudged");

    const result2 = await checkContextExhaustion(session, deps);
    expect(result2).toBe("none"); // cooldown active
  });
});

// ---------------------------------------------------------------------------
// runProductivityChecks
// ---------------------------------------------------------------------------

describe("runProductivityChecks", () => {
  it("returns zeros when no sessions", async () => {
    const result = await runProductivityChecks([], makeDeps());
    expect(result).toEqual({ cleanedUp: 0, nudged: 0, errors: 0 });
  });

  it("skips killed sessions without calling ghRest", async () => {
    const deps = makeDeps({ ghRest: async () => { throw new Error("should not be called"); } });
    const sessions = [
      makeSession({ id: "dead", status: "killed" }),
      makeSession({ id: "alive", status: "pr_open", metadata: { tmuxName: "jc-1" } }),
    ];
    const result = await runProductivityChecks(sessions as any, deps);
    expect(result).toEqual({ cleanedUp: 0, nudged: 0, errors: 0 });
  });

  it("counts cleanedUp when merged PR is found", async () => {
    const deps = makeDeps({
      ghRest: async () => ({ state: "closed", merged: true }),
    });
    const sessions = [
      makeSession({
        id: "s1",
        status: "pr_open",
        pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
      }),
    ];
    const result = await runProductivityChecks(sessions as any, deps);
    expect(result.cleanedUp).toBe(1);
  });

  it("handles errors gracefully without crashing", async () => {
    // All check functions catch their own errors internally, so runProductivityChecks
    // should always return a valid result (never throw). This test verifies the
    // error-boundary holds across all session states.
    const deps = makeDeps({
      ghRest: async () => { throw new Error("api error"); },
    });
    const sessions = [
      makeSession({
        id: "s1",
        status: "pr_open",
        pr: { number: 123, owner: "jleechanorg", repo: "agent-orchestrator", url: "https://github.com/jleechanorg/agent-orchestrator/pull/123", title: "Test PR", branch: "feat/x", baseBranch: "main" }, metadata: { tmuxName: "jc-1" },
      }),
    ];
    // Should not throw — all errors are caught internally in each check function
    const result = await runProductivityChecks(sessions as any, deps);
    expect(result).toHaveProperty("cleanedUp");
    expect(result).toHaveProperty("nudged");
    expect(result).toHaveProperty("errors");
  });
});
