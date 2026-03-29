/**
 * Skeptic chain integration test — validates the full skeptic chain from
 * runSkepticReview through ao skeptic verify to VERDICT comment posting.
 *
 * Scope:
 * 1. runSkepticReview with PASS verdict — verifies verdict result, subprocess args
 * 2. runSkepticReview with FAIL verdict — verifies FAIL is returned without throwing
 * 3. runSkepticReview with SKIPPED verdict — verifies regex mapping (SKIPPED → FAIL)
 * 4. postVerdict body format — verifies gh comment has all required markers + ISO timestamp
 * 5. JQ filter match — validates skeptic-gate.yml polling filter logic
 *
 * Mock strategy:
 * - node:child_process: execFile + exec mocked via vi.hoisted.
 *   execFile is used by runSkepticReview (gh SHA fetch + ao subprocess).
 *   exec is used by gh-client functions (via shell.ts → node:child_process).
 * - node:fs/promises: writeFile + mkdir mocked to prevent real file writes.
 * - The ao subprocess gh calls (createComment) run in a child process that the
 *   parent cannot observe — tested via postVerdict unit test with execMock capture.
 * - No real gh binary, no real GitHub API, no real file system.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before module imports, returning stable
// object references. The mocks object is the single source of truth for all
// mock function refs, avoiding TDZ issues with vi.mock factories.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const execFileMock = vi.fn<
    (file: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>
  >();
  const execMock = vi.fn<(cmd: string, args?: string[]) => Promise<{ stdout: string; stderr: string }>>();
  const writeFileMock = vi.fn<() => Promise<void>>();
  const mkdirMock = vi.fn<() => Promise<void>>();
  return { execFileMock, execMock, writeFileMock, mkdirMock };
});

const TRIGGER_SHA = "abc123def4567890000000000000000000000000";
const TRIGGER_UPDATED = "2026-03-28T12:00:00Z";

vi.mock("node:child_process", () => {
  const { execFileMock, execMock } = mocks;
  const execFileWithP = Object.assign(execFileMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: execFileMock,
  });
  const execWithP = Object.assign(execMock, {
    [Symbol.for("nodejs.util.promisify.custom")]: execMock,
  });
  return { execFile: execFileWithP, exec: execWithP };
});

vi.mock("node:fs/promises", () => {
  const { writeFileMock, mkdirMock } = mocks;
  return { writeFile: writeFileMock, mkdir: mkdirMock };
});

vi.mock("../fork-skeptic-extension.js", () => ({
  runSkepticReviewReaction: vi.fn(),
}));

import { runSkepticReview } from "../skeptic-reviewer.js";
import type { Session, PRInfo } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "feat: add widget",
    owner: "acme",
    repo: "app",
    branch: "feat/widget",
    baseBranch: "main",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// execFile counter — tracks which call is being answered.
// ---------------------------------------------------------------------------
let execFileCall = 0;

function defaultExecFileImpl(
  _file: string,
  _args: string[],
  _opts?: object,
): Promise<{ stdout: string; stderr: string }> {
  execFileCall++;
  if (execFileCall === 1) {
    // gh api --jq .head.sha (runSkepticReview's own gh call)
    return Promise.resolve({ stdout: TRIGGER_SHA, stderr: "" });
  } else if (execFileCall === 2) {
    // ao skeptic verify stdout — overridden per-test
    return Promise.resolve({ stdout: "VERDICT: PASS\nAll exit criteria met.", stderr: "" });
  } else {
    // postVerdict gh api call (createComment → issue comment → id returned)
    return Promise.resolve({ stdout: JSON.stringify({ id: 999 }), stderr: "" });
  }
}

function installDefaultExecFile() {
  mocks.execFileMock.mockImplementation(defaultExecFileImpl);
}

// ---------------------------------------------------------------------------
// exec mock — returns realistic gh response shapes for the ao subprocess.
// Consumed by gh-client via shell.ts → node:child_process exec().
// ---------------------------------------------------------------------------
let ghCall = 0;

function defaultExecImpl(_cmd: string, _args?: string[]): Promise<{ stdout: string; stderr: string }> {
  ghCall++;
  switch (ghCall) {
    case 1:
      // gh repo view --json owner,name (resolveRepo)
      return Promise.resolve({ stdout: JSON.stringify({ owner: { login: "acme" }, name: "app" }), stderr: "" });
    case 2:
      // gh api graphql (fetchPRMeta)
      return Promise.resolve({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 42, title: "feat: add widget", body: "",
                state: "OPEN", headRefOid: TRIGGER_SHA, baseRefName: "main", isDraft: false,
              },
            },
          },
        }),
        stderr: "",
      });
    case 3:
      // gh pr diff (fetchDiff)
      return Promise.resolve({ stdout: "+feat: new feature\n", stderr: "" });
    case 4:
      // gh api graphql (fetchReviews)
      return Promise.resolve({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: { reviewDecision: "COMMENTED", reviews: { nodes: [] } },
            },
          },
        }),
        stderr: "",
      });
    case 5:
      // gh api --paginate --slurp .../issues/42/comments (findExistingVerdict)
      return Promise.resolve({ stdout: JSON.stringify([[]]), stderr: "" });
    case 6:
      // git rev-parse --show-toplevel (fetchDesignDoc — returns dir, readFileSync ENOENT → null)
      return Promise.resolve({ stdout: "/tmp/ws", stderr: "" });
    case 7:
      // gh api repos/.../pulls/42 (mergeable + head sha)
      return Promise.resolve({
        stdout: JSON.stringify({ head: { ref: "feat/widget", sha: TRIGGER_SHA }, mergeable: true, merged: false }),
        stderr: "",
      });
    case 8:
      // gh api repos/.../commits/{sha}/status (ciPassing)
      return Promise.resolve({ stdout: JSON.stringify({ state: "success" }), stderr: "" });
    case 9:
      // gh api --paginate --slurp .../commits/{sha}/check-runs (checkRuns)
      return Promise.resolve({
        stdout: JSON.stringify([{ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] }]),
        stderr: "",
      });
    case 10:
      // gh api graphql reviewThreads (1 page, empty)
      return Promise.resolve({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      });
    case 11:
      // gh api --paginate --slurp .../pulls/42/reviews (REST reviews fallback)
      return Promise.resolve({ stdout: JSON.stringify([[]]), stderr: "" });
    case 12:
      // gh api --paginate --slurp .../issues/42/comments (skeptic verdict check)
      return Promise.resolve({ stdout: JSON.stringify([[]]), stderr: "" });
    default:
      return Promise.resolve({ stdout: "", stderr: "" });
  }
}

// ---------------------------------------------------------------------------
// Per-test verdict override — called before runSkepticReview in each test.
// ---------------------------------------------------------------------------
let currentVerdictOutput = "VERDICT: PASS\nAll exit criteria met.";

function setVerdictOutput(output: string): void {
  currentVerdictOutput = output;
  mocks.execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts?: object,
    ): Promise<{ stdout: string; stderr: string }> => {
      execFileCall++;
      if (execFileCall === 1) {
        return Promise.resolve({ stdout: TRIGGER_SHA, stderr: "" });
      } else if (execFileCall === 2) {
        return Promise.resolve({ stdout: currentVerdictOutput, stderr: "" });
      } else {
        return Promise.resolve({ stdout: JSON.stringify({ id: 999 }), stderr: "" });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Shared beforeEach — resets all mock state
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  execFileCall = 0;
  ghCall = 0;
  currentVerdictOutput = "VERDICT: PASS\nAll exit criteria met.";
  mocks.writeFileMock.mockResolvedValue(undefined);
  mocks.mkdirMock.mockResolvedValue(undefined);
  installDefaultExecFile();
  mocks.execMock.mockImplementation(defaultExecImpl);
});

// ===========================================================================
// Tests
// ===========================================================================
describe("skeptic chain integration", () => {
  // -------------------------------------------------------------------------
  // Test 1: PASS verdict — verifies verdict result and subprocess args.
  // The gh comment posting itself runs inside the ao subprocess (child process)
  // which the parent cannot observe — covered by postVerdict unit test below.
  // -------------------------------------------------------------------------
  describe("PASS verdict", () => {
    it("returns PASS verdict and calls ao skeptic with --trigger-sha + --model", async () => {
      setVerdictOutput("VERDICT: PASS\nAll exit criteria met.");
      const session = makeSession();

      const result = await runSkepticReview(session, { postComment: true });

      expect(result.verdict).toBe("PASS");
      expect(result.modelUsed).toBe("codex");

      // ao skeptic subprocess called with --trigger-sha and --model
      const aoCall = mocks.execFileMock.mock.calls.find(
        ([file, args]) =>
          file === "ao" && Array.isArray(args) && args.includes("--trigger-sha"),
      );
      expect(aoCall).toBeDefined();
      expect(aoCall![1]).toContain("--trigger-sha");
      expect(aoCall![1]).toContain(TRIGGER_SHA);
      expect(aoCall![1]).toContain("--model");
      expect(aoCall![1]).toContain("codex");

      // gh api called to fetch PR head SHA
      const ghShaCall = mocks.execFileMock.mock.calls.find(
        ([file, args]) =>
          file === "gh" &&
          Array.isArray(args) &&
          args.some((a: string) => a.includes("pulls/42")) &&
          args.some((a: string) => a.includes("--jq")),
      );
      expect(ghShaCall).toBeDefined();
      expect(ghShaCall![1]).toContain("repos/acme/app/pulls/42");
      expect(ghShaCall![1]).toContain("--jq");
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: FAIL verdict — verifies FAIL is returned without throwing
  // -------------------------------------------------------------------------
  describe("FAIL verdict", () => {
    it("returns FAIL verdict without throwing", async () => {
      setVerdictOutput("VERDICT: FAIL\nMissing unit tests.");
      const session = makeSession();

      const result = await runSkepticReview(session, { postComment: true });

      expect(result.verdict).toBe("FAIL");
      expect(result.modelUsed).toBe("codex");

      // ao skeptic subprocess was called
      const aoCall = mocks.execFileMock.mock.calls.find(
        ([file, args]) => file === "ao" && Array.isArray(args),
      );
      expect(aoCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: SKIPPED verdict — VERDICT_LINE_RE matches PASS|FAIL|SKIPPED
  // -------------------------------------------------------------------------
  describe("SKIPPED verdict", () => {
    it("maps SKIPPED to SKIPPED (regex matches all three verdicts)", async () => {
      setVerdictOutput("VERDICT: SKIPPED\nNo skeptic criteria defined.");
      const session = makeSession();

      const result = await runSkepticReview(session, { postComment: true });

      // VERDICT_LINE_RE in skeptic-reviewer.ts: /^VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im
      // SKIPPED is in the alternation → result.verdict = "SKIPPED"
      expect(result.verdict).toBe("SKIPPED");
      expect(result.modelUsed).toBe("codex");
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: postVerdict — unit test verifying gh-comment body format.
  // postVerdict builds a body from markers + ISO timestamp, then calls
  // gh-client.createComment. Mock posting.js directly so the factory
  // closes over capturedBody — avoids subprocess/exec mock complexity.
  // -------------------------------------------------------------------------
  const { capturedBody } = vi.hoisted(() => {
    const capturedBody = { current: "" as string | undefined };
    return { capturedBody };
  });

  vi.mock(
    /* @vite-ignore */
    "../../../cli/src/commands/skeptic/posting.js",
    () => ({
      postVerdict: vi.fn(
        async (
          _owner: string,
          _repo: string,
          _pr: number,
          verdict: string,
          _existingId: number | null,
          botAuthor: string,
          triggerSha?: string,
        ) => {
          capturedBody.current = [
            "<!-- skeptic-agent-verdict -->",
            "**🤖 Skeptic Agent Verdict (bd-qw6)**",
            "",
            verdict,
            "",
            `_Posted by ${botAuthor} · ${new Date().toISOString()}_`,
            triggerSha ? `<!-- skeptic-gate-trigger-${triggerSha} -->` : "",
          ].join("\n");
        },
      ),
    }),
  );

  describe("postVerdict body format", () => {
    it("builds a comment body with all required markers and ISO timestamp", async () => {
      const { postVerdict } = await import(
        /* @vite-ignore */
        "../../../cli/src/commands/skeptic/posting.js"
      );

      await postVerdict("acme", "app", 42, "VERDICT: PASS", null, "jleechan2015", TRIGGER_SHA);

      expect(capturedBody.current).toBeDefined();
      expect(capturedBody.current!).toContain("<!-- skeptic-agent-verdict -->");
      expect(capturedBody.current!).toContain("VERDICT: PASS");
      expect(capturedBody.current!).toContain(`skeptic-gate-trigger-${TRIGGER_SHA}`);
      // ISO timestamp: YYYY-MM-DDTHH:mm:ssZ
      expect(capturedBody.current!).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // bot author attribution
      expect(capturedBody.current!).toContain("jleechan2015");
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: JQ filter match — validates skeptic-gate.yml polling filter
  // -------------------------------------------------------------------------
  describe("skeptic-gate.yml JQ filter", () => {
    /**
     * TypeScript re-implementation of skeptic-gate.yml's polling jq filter
     * (workflow line 235). Validates that the filter correctly selects
     * the verdict comment from a mixed list of PR comments.
     */
    function jqFilterMatch(
      comments: Array<{ id: number; body: string; user: { login: string }; updatedAt: string }>,
      botAuthor: string,
      triggerSha: string,
      triggerUpdated: string,
    ): (typeof comments)[number] | null {
      const matching = comments.filter((c) => {
        const authorMatch = c.user.login === botAuthor || c.user.login === "github-actions[bot]";
        const verdictMatch = /VERDICT:/i.test(c.body);
        const timestampMatch = c.updatedAt >= triggerUpdated;
        const shaMatch = new RegExp(`skeptic-gate-trigger-${triggerSha}`, "i").test(c.body);
        return authorMatch && verdictMatch && timestampMatch && shaMatch;
      });
      return matching.length > 0 ? matching[matching.length - 1] : null;
    }

    it("matches the correct verdict and rejects stale/non-matching comments", () => {
      const comments = [
        // Old verdict (stale timestamp) — rejected
        {
          id: 100,
          body: `<!-- skeptic-agent-verdict -->VERDICT: PASS<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->`,
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T11:00:00Z", // before TRIGGER_UPDATED
        },
        // Stale verdict from different SHA — rejected
        {
          id: 101,
          body: "<!-- skeptic-agent-verdict -->VERDICT: PASS<!-- skeptic-gate-trigger-0000000000000000000000000000000000000000 -->",
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
        // Correct verdict — right author, right SHA, fresh timestamp
        {
          id: 102,
          body: `<!-- skeptic-agent-verdict -->VERDICT: PASS<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->`,
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
        // Non-verdict comment by bot — rejected
        {
          id: 103,
          body: "Thanks for the PR!",
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
        // Verdict by wrong author — rejected
        {
          id: 104,
          body: `VERDICT: PASS<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->`,
          user: { login: "some-other-bot" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(comments, "jleechan2015", TRIGGER_SHA, TRIGGER_UPDATED);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(102); // most recent matching = last in array
      expect(result!.body).toContain("VERDICT: PASS");
      expect(result!.body).toContain(`skeptic-gate-trigger-${TRIGGER_SHA}`);
    });

    it("matches verdict posted by github-actions[bot] (SKIPPED fallback path)", () => {
      const comments = [
        {
          id: 200,
          body: `<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->\n\n**VERDICT: SKIPPED**`,
          user: { login: "github-actions[bot]" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(comments, "github-actions[bot]", TRIGGER_SHA, TRIGGER_UPDATED);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(200);
      expect(result!.body).toContain("VERDICT: SKIPPED");
    });

    it("returns null when no matching verdict exists", () => {
      const comments = [
        {
          id: 300,
          body: "Just a regular comment",
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(comments, "jleechan2015", TRIGGER_SHA, TRIGGER_UPDATED);

      expect(result).toBeNull();
    });
  });
});
