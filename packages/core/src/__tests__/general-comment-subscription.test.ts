/**
 * Tests for general comment subscription — lifecycle-manager Phase 3 (orch-nep).
 *
 * Verifies that the lifecycle manager:
 * 1. Fetches ALL recent bot issue comments for each session with an open PR
 * 2. Tracks last-seen comment ID per session in session metadata
 * 3. Fires the correct reaction when a NEW bot comment is detected
 * 4. Does NOT re-fire for already-seen comments (ID <= lastSeen)
 * 5. Skips github-actions[bot] comments
 * 6. Dedupes same-bot same-content within 5 minutes
 * 7. Does NOT change existing CR state-change logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createLifecycleManager, _clearGcsDedupMap } from "../lifecycle-manager.js";
import { writeMetadata, readMetadataRaw, updateMetadata } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import { clearLastSentHeadSha } from "../dedup-head-sha-store.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  Agent,
  SCM,
  ActivityState,
  PRInfo,
  IssueComment,
} from "../types.js";

vi.mock("../fork-lifecycle-postmerge.js", () => ({
  reapPostMergeCoWorkers: vi.fn().mockResolvedValue({ killed: [], hadErrors: false, summary: "none" }),
}));

const { mockRunSkepticReviewReaction } = vi.hoisted<{
  mockRunSkepticReviewReaction: () => Promise<{ success: boolean; message?: string; blockers?: string[] }>;
}>(() => ({
  mockRunSkepticReviewReaction: vi.fn<[], Promise<{ success: boolean; message?: string; blockers?: string[] }>>(),
}));

vi.mock("../fork-skeptic-extension.js", () => ({
  runSkepticReviewReaction: mockRunSkepticReviewReaction,
}));

vi.mock("../ao-action-log.js", () => ({
  logAoAction: vi.fn(),
}));

import { logAoAction } from "../ao-action-log.js";

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockSessionManager: SessionManager;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let mockScm: SCM;
let config: OrchestratorConfig;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "pr_open",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: makePR(),
    workspacePath: tmpDir,
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

function commentsToIssueComments(
  comments: Array<{ id: number; user: { login: string }; body: string; created_at: string; html_url: string }>,
): IssueComment[] {
  return comments.map(
    (c): IssueComment => ({
      id: c.id,
      author: c.user.login,
      body: c.body,
      createdAt: new Date(c.created_at),
      url: c.html_url,
    }),
  );
}

function makeMockScm(getIssueCommentsFn: () => Promise<IssueComment[]>): SCM {
  return {
    name: "github",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn().mockResolvedValue(undefined),
    closePR: vi.fn().mockResolvedValue(undefined),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockResolvedValue("success"),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("approved"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getIssueComments: getIssueCommentsFn,
  };
}

beforeEach(() => {
  vi.mocked(logAoAction).mockReset();
  vi.mocked(mockRunSkepticReviewReaction).mockReset();
  vi.mocked(mockRunSkepticReviewReaction).mockResolvedValue({ success: true });

  // Clear the module-level GCS dedup map between tests to prevent cross-test pollution
  _clearGcsDedupMap();

  tmpDir = join(tmpdir(), `ao-test-gcs-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  mockRuntime = {
    name: "mock",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockScm = makeMockScm(async () => []);

  mockRegistry = {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string) => {
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "scm") return mockScm;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  mockSessionManager = {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  } as SessionManager;

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: ["desktop"], action: ["desktop"], warning: [], info: [] },
    reactions: {
      "skeptic-advice": { action: "send-to-agent", retries: 2, message: "New skeptic comment" },
      "changes-requested": { action: "send-to-agent", retries: 2, message: "New CR comment" },
      "bugbot-comments": { action: "send-to-agent", retries: 2, message: "New cursor comment" },
    },
    readyThresholdMs: 300_000,
    startupGracePeriodMs: 0,
  };

  sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });

  clearLastSentHeadSha();
});

afterEach(() => {
  const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Runs a single checkSession cycle (via lm.check) and returns session metadata.
 * This avoids timing issues from repeated polls via lm.start interval.
 */
async function runCheckSession(
  lastIssueCommentId: string,
  comments: IssueComment[],
): Promise<Record<string, string> | null> {
  mockScm = makeMockScm(async () => comments);

  const session = makeSession();
  writeMetadata(sessionsDir, "app-1", {
    worktree: "/tmp",
    branch: "feat/test",
    status: "pr_open",
    project: "my-app",
    pr: session.pr!.url,
  });
  // writeMetadata does not persist arbitrary keys — use updateMetadata for lastIssueCommentId
  updateMetadata(sessionsDir, "app-1", { lastIssueCommentId });

  // Build metadata from the file so both sessionManager.get (used by lm.check) and
  // sessionManager.list (used internally) return a session with the correct lastIssueCommentId.
  const fileMeta = (readMetadataRaw(sessionsDir, "app-1") as Record<string, string>) ?? {};
  const sessionWithMeta = { ...session, metadata: { ...fileMeta } };

  vi.mocked(mockSessionManager.get).mockResolvedValue(sessionWithMeta);
  vi.mocked(mockSessionManager.list).mockResolvedValue([sessionWithMeta]);

  const lm = createLifecycleManager({
    config,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
  });

  await lm.check("app-1");

  return readMetadataRaw(sessionsDir, "app-1");
}

describe("general comment subscription — detect new bot issue comments", () => {
  it("fires send-to-agent when new skeptic FAIL comment is posted (ID > lastSeen)", async () => {
    const comments = commentsToIssueComments([
      { id: 1, user: { login: "jleechan2015" }, body: "VERDICT: PASS", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-1" },
      { id: 2, user: { login: "jleechan2015" }, body: "Looking good", created_at: "2026-03-29T00:01:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-2" },
      { id: 3, user: { login: "someuser" }, body: "Nice work", created_at: "2026-03-29T00:02:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-3" },
      { id: 4, user: { login: "skeptoid" }, body: "VERDICT: FAIL — insufficient test coverage", created_at: "2026-03-29T00:03:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-4" },
    ]);

    const sendSpy = vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    await runCheckSession("3", comments);

    // skeptic-advice reaction should fire (message contains "skeptic" or "VERDICT")
    const skepticCalls = sendSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "string" &&
        (call[1].toLowerCase().includes("skeptic") || call[1].toLowerCase().includes("verdict")),
    );
    expect(skepticCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT fire reaction for comments with ID <= lastSeen (already processed)", async () => {
    const comments = commentsToIssueComments([
      { id: 1, user: { login: "skeptoid" }, body: "VERDICT: FAIL", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-1" },
      { id: 2, user: { login: "skeptoid" }, body: "More details", created_at: "2026-03-29T00:01:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-2" },
      { id: 3, user: { login: "skeptoid" }, body: "Final verdict", created_at: "2026-03-29T00:02:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-3" },
    ]);

    const sendSpy = vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    await runCheckSession("3", comments);

    // All comments have ID <= lastSeenId=3, no reactions should fire
    const skepticCalls = sendSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "string" &&
        (call[1].toLowerCase().includes("skeptic") || call[1].toLowerCase().includes("verdict")),
    );
    expect(skepticCalls.length).toBe(0);
  });

  it("skips github-actions[bot] comments — excluded from tracked bots", async () => {
    const comments = commentsToIssueComments([
      { id: 99, user: { login: "github-actions[bot]" }, body: "CI check passed", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-99" },
    ]);

    const sendSpy = vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    await runCheckSession("0", comments);

    // github-actions[bot] is excluded — no reaction
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("updates lastIssueCommentId in session metadata after processing new comments", async () => {
    const comments = commentsToIssueComments([
      { id: 5, user: { login: "skeptoid" }, body: "VERDICT: FAIL", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-5" },
    ]);

    vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    const meta = await runCheckSession("0", comments);

    // After processing, lastIssueCommentId should be updated to "5"
    expect(Number(meta?.["lastIssueCommentId"] ?? 0)).toBeGreaterThanOrEqual(5);
  });

  it("fires bugbot-comments reaction when cursor[bot] posts an error comment", async () => {
    const comments = commentsToIssueComments([
      { id: 1, user: { login: "cursor[bot]" }, body: "Error: potential null pointer", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-1" },
    ]);

    const sendSpy = vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    await runCheckSession("0", comments);

    const bugbotCalls = sendSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "string" &&
        (call[1].toLowerCase().includes("cursor") || call[1].toLowerCase().includes("bugbot")),
    );
    expect(bugbotCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT fire bugbot-comments for cursor[bot] non-error comments", async () => {
    const comments = commentsToIssueComments([
      { id: 1, user: { login: "cursor[bot]" }, body: "Suggestion: consider using a constant", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-1" },
    ]);

    const sendSpy = vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    await runCheckSession("0", comments);

    // cursor[bot] comments without "error" severity are skipped
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("deduplicates same bot+content within 5 minutes", async () => {
    const comments = commentsToIssueComments([
      { id: 10, user: { login: "skeptoid" }, body: "VERDICT: FAIL — coverage low", created_at: "2026-03-29T00:00:00Z", html_url: "https://github.com/org/repo/pull/42#issuecomment-10" },
    ]);

    // First check: fires reaction
    const sendSpy1 = vi.spyOn(mockSessionManager, "send").mockResolvedValue(undefined);
    await runCheckSession("0", comments);
    expect(sendSpy1).toHaveBeenCalled();

    // Reset spy and run again: same dedup key within window → skipped
    sendSpy1.mockClear();
    await runCheckSession("0", comments);
    expect(sendSpy1).not.toHaveBeenCalled();
  });
});
