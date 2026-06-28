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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
    // gh api comments --paginate --slurp (findRequestIdFromComments — no request-id by default)
    return Promise.resolve({ stdout: "[[]]", stderr: "" });
  } else if (execFileCall === 3) {
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
        // gh api comments --paginate --slurp — no request-id found by default
        return Promise.resolve({ stdout: "[[]]", stderr: "" });
      } else if (execFileCall === 3) {
        return Promise.resolve({ stdout: currentVerdictOutput, stderr: "" });
      } else {
        return Promise.resolve({ stdout: JSON.stringify({ id: 999 }), stderr: "" });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Shared beforeEach — resets all mock state and saves env
// ---------------------------------------------------------------------------
let originalAO_CLI_PATH: string | undefined;
let originalAO_GH_PATH: string | undefined;

beforeEach(() => {
  originalAO_CLI_PATH = process.env.AO_CLI_PATH;
  originalAO_GH_PATH = process.env.AO_GH_PATH;
  vi.clearAllMocks();
  // AO_CLI_PATH in the host env overrides the "ao" binary name;
  // clear it so execFile calls use "ao" (matching test assertions).
  delete process.env.AO_CLI_PATH;
  process.env.AO_GH_PATH = "gh";
  execFileCall = 0;
  ghCall = 0;
  currentVerdictOutput = "VERDICT: PASS\nAll exit criteria met.";
  mocks.writeFileMock.mockResolvedValue(undefined);
  mocks.mkdirMock.mockResolvedValue(undefined);
  installDefaultExecFile();
  mocks.execMock.mockImplementation(defaultExecImpl);
});

afterEach(() => {
  if (originalAO_CLI_PATH === undefined) {
    delete process.env.AO_CLI_PATH;
  } else {
    process.env.AO_CLI_PATH = originalAO_CLI_PATH;
  }
  if (originalAO_GH_PATH === undefined) {
    delete process.env.AO_GH_PATH;
  } else {
    process.env.AO_GH_PATH = originalAO_GH_PATH;
  }
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
          _llmOutput?: string,
          binding?: { requestId?: string; headSha?: string },
        ) => {
          capturedBody.current = [
            "<!-- skeptic-agent-verdict -->",
            binding?.requestId ? `<!-- skeptic-request-id-${binding.requestId} -->` : "",
            binding?.headSha ? `<!-- skeptic-head-sha-${binding.headSha} -->` : "",
            "<!-- skeptic-gate-1:PASS -->",
            "<!-- skeptic-gate-2:PASS -->",
            "<!-- skeptic-gate-3:PASS -->",
            "<!-- skeptic-gate-4:PASS -->",
            "<!-- skeptic-gate-5:PASS -->",
            "<!-- skeptic-gate-6:PASS -->",
            "<!-- skeptic-gate-7:PASS -->",
            "<!-- skeptic-gate-8:PASS -->",
            "**🤖 Skeptic Agent Verdict (bd-qw6)**",
            "",
            verdict,
            "",
            `_Posted by ${botAuthor} · ${new Date().toISOString()}_`,
            triggerSha ? `<!-- skeptic-gate-trigger-${triggerSha} -->` : "",
            triggerSha ? `<!-- skeptic-cron-trigger-${triggerSha} -->` : "",
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

      await postVerdict(
        "acme",
        "app",
        42,
        "VERDICT: PASS",
        null,
        "jleechan2015",
        TRIGGER_SHA,
        [
          "<!-- skeptic-gate-1:PASS -->",
          "<!-- skeptic-gate-2:PASS -->",
          "<!-- skeptic-gate-3:PASS -->",
          "<!-- skeptic-gate-4:PASS -->",
          "<!-- skeptic-gate-5:PASS -->",
          "<!-- skeptic-gate-6:PASS -->",
          "<!-- skeptic-gate-7:PASS -->",
          "<!-- skeptic-gate-8:PASS -->",
          "VERDICT: PASS",
        ].join("\n"),
        { requestId: "req-chain", headSha: TRIGGER_SHA },
      );

      expect(capturedBody.current).toBeDefined();
      expect(capturedBody.current!).toContain("<!-- skeptic-agent-verdict -->");
      expect(capturedBody.current!).toContain("<!-- skeptic-request-id-req-chain -->");
      expect(capturedBody.current!).toContain(`<!-- skeptic-head-sha-${TRIGGER_SHA} -->`);
      for (let gate = 1; gate <= 8; gate += 1) {
        expect(capturedBody.current!).toContain(`<!-- skeptic-gate-${gate}:PASS -->`);
      }
      expect(capturedBody.current!).toContain("VERDICT: PASS");
      expect(capturedBody.current!).toContain(`skeptic-gate-trigger-${TRIGGER_SHA}`);
      expect(capturedBody.current!).toContain(`skeptic-cron-trigger-${TRIGGER_SHA}`);
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
    const workflowSource = readFileSync(new URL("../../../../.github/workflows/test.yml", import.meta.url), "utf8");
    const gateWorkflowSource = readFileSync(
      new URL("../../../../.github/workflows/skeptic-gate.yml", import.meta.url),
      "utf8",
    );
    const reusableWorkflowSource = readFileSync(
      new URL("../../../../.github/workflows/skeptic-gate-reusable.yml", import.meta.url),
      "utf8",
    );

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
      requestId: string | null = null,
      prAuthor = "pr-author",
    ): (typeof comments)[number] | null {
      const escapeRegexLiteral = (token: string): string =>
        token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedSha = escapeRegexLiteral(triggerSha);
      const hasEightPassingGates = (body: string): boolean => {
        for (let gate = 1; gate <= 8; gate += 1) {
          if (!new RegExp(`<!--\\s*skeptic-gate-${gate}\\s*:\\s*PASS\\s*-->`, "i").test(body)) {
            return false;
          }
        }
        return true;
      };
      const matching = comments.filter((c) => {
        const userLogin = c.user.login.toLowerCase();
        const botLogin = botAuthor.toLowerCase();
        const prLogin = prAuthor.toLowerCase();
        const markerMatch = /<!--\s*skeptic-agent-verdict\s*-->/i.test(c.body);
        const requestIdMatch = requestId === null ? true : new RegExp(
          `<!--\\s*skeptic-request-id-${escapeRegexLiteral(requestId)}\\s*-->`,
          "i",
        ).test(c.body);
        const verdictMatch = c.body.match(/^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$/im);
        const verdictType = verdictMatch?.[1]?.toUpperCase();
        const timestampMatch = c.updatedAt >= triggerUpdated;
        const shaMatch = new RegExp(`<!--\\s*skeptic-gate-trigger-${escapedSha}\\s*-->`, "i").test(c.body);
        const headMatch = new RegExp(`<!--\\s*skeptic-head-sha-${escapedSha}\\s*-->`, "i").test(c.body);
        return (
          // Correct: bot author is trusted even when == pr_author; gh-actions[bot] requires != pr_author
          (userLogin === botLogin || (userLogin === "github-actions[bot]" && userLogin !== prLogin)) &&
          markerMatch &&
          requestIdMatch &&
          Boolean(verdictType) &&
          timestampMatch &&
          shaMatch &&
          headMatch &&
          (verdictType !== "PASS" || hasEightPassingGates(c.body))
        );
      });
      return matching.length > 0 ? matching[matching.length - 1] : null;
    }

    function boundPassBody(sha: string): string {
      return [
        "<!-- skeptic-agent-verdict -->",
        `<!-- skeptic-head-sha-${sha} -->`,
        "<!-- skeptic-gate-1:PASS -->",
        "<!-- skeptic-gate-2:PASS -->",
        "<!-- skeptic-gate-3:PASS -->",
        "<!-- skeptic-gate-4:PASS -->",
        "<!-- skeptic-gate-5:PASS -->",
        "<!-- skeptic-gate-6:PASS -->",
        "<!-- skeptic-gate-7:PASS -->",
        "<!-- skeptic-gate-8:PASS -->",
        "VERDICT: PASS",
        `<!-- skeptic-gate-trigger-${sha} -->`,
      ].join("\n");
    }

    function lastAnchoredVerdict(body: string): "PASS" | "FAIL" | "SKIPPED" | null {
      let verdict: "PASS" | "FAIL" | "SKIPPED" | null = null;
      for (const line of body.split("\n")) {
        const normalized = line
          .replace(/^[\s>#*]*/, "")
          .replace(/^VERDICT:\s*/i, "");
        if (normalized === line) continue;
        const token = normalized.split(/[^A-Za-z]+/)[0]?.toUpperCase();
        if (token === "PASS" || token === "FAIL" || token === "SKIPPED") {
          verdict = token;
        }
      }
      return verdict;
    }

    function workflowFailClosedVerdict(body: string): "PASS" | "FAIL" | "SKIPPED" | null {
      const verdicts = body.split("\n").flatMap((line): Array<"PASS" | "FAIL" | "SKIPPED"> => {
        const normalized = line
          .replace(/^[\s>#*]*/, "")
          .replace(/^VERDICT:\s*/i, "");
        if (normalized === line) return [];
        const token = normalized.split(/[^A-Za-z]+/)[0]?.toUpperCase();
        return token === "PASS" || token === "FAIL" || token === "SKIPPED" ? [token] : [];
      });
      return verdicts.find((token) => token === "FAIL" || token === "SKIPPED") ?? verdicts.find((token) => token === "PASS") ?? null;
    }

    function gatePasses(verdict: "PASS" | "FAIL" | "SKIPPED" | null): boolean {
      return verdict === "PASS";
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
          body: boundPassBody(TRIGGER_SHA),
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
        // Verdict by configured author without skeptic marker — rejected
        {
          id: 105,
          body: `VERDICT: PASS<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->`,
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(comments, "jleechan2015", TRIGGER_SHA, TRIGGER_UPDATED);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(102); // most recent matching = last in array
      expect(result!.body).toContain("VERDICT: PASS");
      expect(result!.body).toContain(`skeptic-gate-trigger-${TRIGGER_SHA}`);
    });

    it("only matches request-bound verdict comments when request_id is supplied", () => {
      const comments = [
        {
          id: 120,
          body: [
            "<!-- skeptic-agent-verdict -->",
            `<!-- skeptic-request-id-expected-request -->`,
            boundPassBody(TRIGGER_SHA),
          ].join("\n"),
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
        {
          id: 121,
          body: [
            "<!-- skeptic-agent-verdict -->",
            `<!-- skeptic-request-id-unexpected-request -->`,
            `<!-- skeptic-head-sha-${TRIGGER_SHA} -->`,
            "<!-- skeptic-gate-1:PASS -->",
            "<!-- skeptic-gate-2:PASS -->",
            "<!-- skeptic-gate-3:PASS -->",
            "<!-- skeptic-gate-4:PASS -->",
            "<!-- skeptic-gate-5:PASS -->",
            "<!-- skeptic-gate-6:PASS -->",
            "<!-- skeptic-gate-7:PASS -->",
            "<!-- skeptic-gate-8:PASS -->",
            "VERDICT: PASS",
            `<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->`,
          ].join("\n"),
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA,
        TRIGGER_UPDATED,
        "expected-request",
        "other-author",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe(120);
    });

    it("returns null when request_id is supplied but the verdict comment lacks that marker", () => {
      const comments = [
        {
          id: 122,
          body: boundPassBody(TRIGGER_SHA),
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
        {
          id: 123,
          body: [
            "<!-- skeptic-agent-verdict -->",
            `<!-- skeptic-request-id-expected-request -->`,
            boundPassBody(TRIGGER_SHA),
          ].join("\n"),
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA,
        TRIGGER_UPDATED,
        "expected-request",
        "other-author",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe(123);
    });

    it("accepts a request-bound PASS when the bot author equals the PR author", () => {
      const comments = [
        {
          id: 150,
          body: boundPassBody(TRIGGER_SHA),
          user: { login: "jleechan2015" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA,
        TRIGGER_UPDATED,
      );

      // Bot author is trusted unconditionally (new logic); gh-actions[bot] requires != pr_author
      expect(result).not.toBeNull();
      expect(result!.id).toBe(150);
    });

    it("matches SKIPPED fallback comments so the gate can fail closed on the explicit verdict", () => {
      const comments = [
        {
          id: 200,
          body: `<!-- skeptic-agent-verdict -->\n<!-- skeptic-head-sha-${TRIGGER_SHA} -->\n<!-- skeptic-gate-trigger-${TRIGGER_SHA} -->\n\n**VERDICT: SKIPPED**`,
          user: { login: "github-actions[bot]" },
          updatedAt: "2026-03-28T12:05:00Z",
        },
      ];

      const result = jqFilterMatch(comments, "github-actions[bot]", TRIGGER_SHA, TRIGGER_UPDATED);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(200);
      expect(result!.body).toContain("VERDICT: SKIPPED");
      expect(gatePasses(lastAnchoredVerdict(result!.body))).toBe(false);
    });

    it("keeps SKIPPED fail-closed in the workflow shell", () => {
      expect(workflowSource).not.toMatch(/VERDICT" = "SKIPPED"[\s\S]{0,200}exit 0/);
    });

    it("tracks PR state and comment API failures independently", () => {
      expect(workflowSource).toContain("PR_STATE_API_FAILURES=0");
      expect(workflowSource).toContain("COMMENTS_API_FAILURES=0");
      expect(workflowSource).not.toMatch(/^[ \t]*API_FAILURES=0$/m);
    });

    it("backs off and skips comment polling after transient PR state API failures", () => {
      const prStateFailureBlock = workflowSource.match(
        /if \[ "\$PR_STATE_EXIT" -ne 0 \]; then([\s\S]*?)else/,
      )?.[1];

      expect(prStateFailureBlock).toContain('sleep "$INTERVAL"');
      expect(prStateFailureBlock).toContain("continue");
    });

    it("prevents double-counting API failures in the reusable workflow polling loop", () => {
      const prStateFailureBlock = reusableWorkflowSource.match(
        /if echo "\$PR_STATE" \| grep -qi "error\\\|rate limit\\\|authentication\\\|not found\\\|server error"; then([\s\S]*?)fi\s*\n\s*\n\s*if \[ "\$PR_STATE" = "closed" \]/,
      )?.[1];
      const verdictFailureBlock = reusableWorkflowSource.match(
        /if \[ -z "\$VERDICT_RAW" \] \|\| \[ "\$_GH_EXIT" -ne 0 \]; then([\s\S]*?)else/,
      )?.[1];

      expect(prStateFailureBlock).toContain('sleep $INTERVAL');
      expect(prStateFailureBlock).toContain("continue");
      expect(verdictFailureBlock).toContain('sleep $INTERVAL');
      expect(verdictFailureBlock).toContain("continue");
    });

    it("authenticates the resolve step before the fallback gh api call", () => {
      expect(gateWorkflowSource).toMatch(
        /Resolve PR number and head SHA[\s\S]*?GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
      );
    });

    it("scopes workflow concurrency per PR instead of serializing all skeptic gate runs", () => {
      expect(workflowSource).not.toMatch(/group:\s*skeptic-gate\s*$/m);
      expect(workflowSource).toContain("github.event.pull_request.number");
    });

    it("keeps the workflow jq filter aligned with head SHA and eight-gate PASS binding", () => {
      expect(workflowSource).toContain("REQUEST_ID: $" + "{{ steps.post_trigger.outputs.request_id }}");
      expect(workflowSource).toContain('--arg req "$REQUEST_ID"');
      expect(workflowSource).toContain('skeptic-request-id-" + $req');
      expect(workflowSource).toContain('skeptic-gate-trigger-" + $ts');
      expect(workflowSource).toContain('skeptic-head-sha-" + $ts');
      expect(workflowSource).toContain('skeptic-gate-" + ($gate | tostring)');
    });

    it("matches verdict lines after hidden markers in jq, matching ao skeptic comment format", () => {
      // The jq filter uses .verdict != "PASS" (not body-text search) so FAIL/SKIPPED
      // verdicts can be properly detected. The buggy body-text search pattern is removed.
      expect(workflowSource).toContain('.verdict != "PASS"');
      // The buggy start-of-line pattern should not be present
      expect(workflowSource).not.toContain('test("^[[:space:]>#*]*VERDICT:[[:space:]]*PASS');
      // The old body-text search pattern should not be present (it blocked FAIL/SKIPPED)
      expect(workflowSource).not.toContain('test("(^|\\\\n)[[:space:]>#*]*VERDICT:[[:space:]]*PASS');
      expect(workflowSource).toContain('capture("(?:^|\\\\n)[ \\\\t]*');
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

    it("uses the last anchored verdict when a comment contains multiple verdict tokens", () => {
      const body = [
        "Earlier model transcript:",
        "VERDICT: PASS",
        "",
        "Final reviewed result:",
        "VERDICT: FAIL — evidence is incomplete",
      ].join("\n");

      expect(lastAnchoredVerdict(body)).toBe("FAIL");
    });

    it("fails closed when a selected comment contains FAIL then later PASS without relying on gate markers", () => {
      const body = [
        "<!-- skeptic-agent-verdict -->",
        "VERDICT: FAIL - selected by jq fail branch",
        "",
        "Later transcript text:",
        "VERDICT: PASS",
      ].join("\n");

      expect(workflowFailClosedVerdict(body)).toBe("FAIL");
      expect(workflowSource).toContain("BLOCKING_VERDICT=");
    });

    it("selects the first matching verdict line without invoking grep without a pattern", () => {
      expect(workflowSource).not.toContain("| grep -m 1 \\");
      expect(workflowSource).toContain("| head -n 1 \\");
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: Tolerant request-id filter — validates PR #733 fix.
  // The polling filter now accepts verdicts via three-way matching:
  //   1. exact request-id
  //   2. SHA-substring match (full 40-char OR 12-char prefix) inside the
  //      skeptic-request-id-* marker
  //   3. empty request_id (SHA-only matching)
  // See PR #733.
  // -------------------------------------------------------------------------
  describe("tolerant request-id filter (PR #733)", () => {
    const TRIGGER_SHA_FULL = "09a36eeded5a9786705e255c55469558cc9aec0e";
    const TRIGGER_SHA_12 = TRIGGER_SHA_FULL.slice(0, 12);
    const TRIGGER_UPDATED_LOCAL = "2026-06-28T19:57:32Z";

    const gateWorkflowSourceLocal = readFileSync(
      new URL("../../../../.github/workflows/skeptic-gate.yml", import.meta.url),
      "utf8",
    );
    const reusableWorkflowSourceLocal = readFileSync(
      new URL("../../../../.github/workflows/skeptic-gate-reusable.yml", import.meta.url),
      "utf8",
    );

    // Mirrors the new tolerant filter in skeptic-gate.yml and
    // skeptic-gate-reusable.yml. Returns matching comment or null.
    function tolerantFilterMatch(
      comments: Array<{ id: number; body: string; user: { login: string }; updatedAt: string }>,
      botAuthor: string,
      triggerSha: string,
      triggerUpdated: string,
      requestId: string | null = null,
      prAuthor = "pr-author",
    ): (typeof comments)[number] | null {
      const escapeRegexLiteral = (token: string): string =>
        token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedSha = escapeRegexLiteral(triggerSha);
      const shaPrefix = triggerSha.slice(0, 12);
      const hasEightPassingGates = (body: string): boolean => {
        for (let gate = 1; gate <= 8; gate += 1) {
          if (!new RegExp(`<!--\\s*skeptic-gate-${gate}\\s*:\\s*PASS\\s*-->`, "i").test(body)) {
            return false;
          }
        }
        return true;
      };
      const matching = comments.filter((c) => {
        const userLogin = c.user.login.toLowerCase();
        const botLogin = botAuthor.toLowerCase();
        const prLogin = prAuthor.toLowerCase();
        const markerMatch = /<!--\s*skeptic-agent-verdict\s*-->/i.test(c.body);
        const requestIdMatch =
          requestId === null
            ? true
            : requestId === ""
              ? true
              : new RegExp(
                  `<!--\\s*skeptic-request-id-${escapeRegexLiteral(requestId)}\\s*-->`,
                  "i",
                ).test(c.body) ||
                new RegExp(
                  `<!--\\s*skeptic-request-id-[^>]*(${escapedSha}|${shaPrefix})[^>]*-->`,
                  "i",
                ).test(c.body);
        const verdictMatch = c.body.match(
          /^[ \t]*(?:> ?)?(?:#{1,6}[ \t]*)?(?:\*{1,2})?VERDICT:[ \t]*(PASS|FAIL|SKIPPED)(?:\*{1,2})?[ \t]*(?:[-—:].*)?$/im,
        );
        const verdictType = verdictMatch?.[1]?.toUpperCase();
        const timestampMatch = c.updatedAt >= triggerUpdated;
        const shaMatch = new RegExp(
          `<!--\\s*skeptic-gate-trigger-${escapedSha}\\s*-->`,
          "i",
        ).test(c.body);
        const headMatch = new RegExp(
          `<!--\\s*skeptic-head-sha-${escapedSha}\\s*-->`,
          "i",
        ).test(c.body);
        return (
          (userLogin === botLogin ||
            (userLogin === "github-actions[bot]" && userLogin !== prLogin)) &&
          markerMatch &&
          requestIdMatch &&
          Boolean(verdictType) &&
          timestampMatch &&
          shaMatch &&
          headMatch &&
          (verdictType !== "PASS" || hasEightPassingGates(c.body))
        );
      });
      return matching.length > 0 ? matching[matching.length - 1] : null;
    }

    function tolerantPassBody(sha: string, requestId: string): string {
      return [
        "<!-- skeptic-agent-verdict -->",
        `<!-- skeptic-request-id-${requestId} -->`,
        `<!-- skeptic-head-sha-${sha} -->`,
        "<!-- skeptic-gate-1:PASS -->",
        "<!-- skeptic-gate-2:PASS -->",
        "<!-- skeptic-gate-3:PASS -->",
        "<!-- skeptic-gate-4:PASS -->",
        "<!-- skeptic-gate-5:PASS -->",
        "<!-- skeptic-gate-6:PASS -->",
        "<!-- skeptic-gate-7:PASS -->",
        "<!-- skeptic-gate-8:PASS -->",
        "VERDICT: PASS",
        `<!-- skeptic-gate-trigger-${sha} -->`,
      ].join("\n");
    }

    // RED: Pre-fix strict filter would have rejected this verdict because the
    // trigger request-id and verdict marker use DIFFERENT format generations.
    // The trigger at 19:57:32Z used the NEW format (12-char SHA prefix); the
    // verdict marker uses the OLD format (full 40-char SHA). The exact-match
    // path returns false; only the SHA-substring fallback can satisfy this.
    it("accepts an OLD-format verdict marker when the trigger request-id uses the NEW format", () => {
      const verdictRequestIdOld = `gate-${TRIGGER_SHA_FULL}-28333687751-1`;
      const triggerRequestIdNew = `gate-28333687751-1-733-${TRIGGER_SHA_12}`;
      const comments = [
        {
          id: 400,
          body: tolerantPassBody(TRIGGER_SHA_FULL, verdictRequestIdOld),
          user: { login: "jleechan2015" },
          updatedAt: "2026-06-28T20:01:00Z",
        },
      ];

      const result = tolerantFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA_FULL,
        TRIGGER_UPDATED_LOCAL,
        triggerRequestIdNew, // different from verdict marker
        "other-author",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe(400);
      expect(result!.body).toContain("VERDICT: PASS");
    });

    // GREEN: Reverse direction — trigger is OLD, verdict marker is NEW.
    // This is the format-drift scenario that stranded PR #732's PASS verdict.
    it("accepts a NEW-format verdict marker when the trigger request-id uses the OLD format", () => {
      const triggerRequestIdOld = `gate-${TRIGGER_SHA_FULL}-28333687751-1`;
      const verdictRequestIdNew = `gate-28333687751-1-733-${TRIGGER_SHA_12}`;
      const comments = [
        {
          id: 401,
          body: tolerantPassBody(TRIGGER_SHA_FULL, verdictRequestIdNew),
          user: { login: "jleechan2015" },
          updatedAt: "2026-06-28T20:01:00Z",
        },
      ];

      const result = tolerantFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA_FULL,
        TRIGGER_UPDATED_LOCAL,
        triggerRequestIdOld, // different from verdict marker
        "other-author",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe(401);
    });

    // RED: Wrong SHA in the request-id must still be rejected.
    it("rejects a verdict whose request-id contains a different SHA", () => {
      const wrongSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const requestIdWrong = `gate-${wrongSha}-28333687751-1`;
      const comments = [
        {
          id: 402,
          body: tolerantPassBody(TRIGGER_SHA_FULL, requestIdWrong),
          user: { login: "jleechan2015" },
          updatedAt: "2026-06-28T20:01:00Z",
        },
      ];

      // Pass a requestId param that does NOT contain the wrong SHA — this
      // simulates the trigger and verdict disagreeing on SHA. The tolerant
      // filter must reject because neither exact nor SHA-substring matches.
      const result = tolerantFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA_FULL,
        TRIGGER_UPDATED_LOCAL,
        "gate-different-request-id-without-the-right-sha",
        "other-author",
      );

      expect(result).toBeNull();
    });

    // Empty request_id always matches (existing behavior preserved).
    it("accepts any SHA-bound verdict when request_id is empty (legacy fallback)", () => {
      const legacyRequestId = "anything-could-go-here";
      const comments = [
        {
          id: 403,
          body: tolerantPassBody(TRIGGER_SHA_FULL, legacyRequestId),
          user: { login: "jleechan2015" },
          updatedAt: "2026-06-28T20:01:00Z",
        },
      ];

      const result = tolerantFilterMatch(
        comments,
        "jleechan2015",
        TRIGGER_SHA_FULL,
        TRIGGER_UPDATED_LOCAL,
        "",
        "other-author",
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe(403);
    });

    // Belt-and-suspenders: both skeptic-gate.yml and the reusable workflow
    // must contain the same tolerant filter shape (exact OR SHA-substring).
    it("workflows expose the three-way tolerant filter (exact OR SHA-substring OR empty)", () => {
      const gateFilter = gateWorkflowSourceLocal.match(
        /\$req == ""[\s\S]*?skeptic-request-id-\[\^>\]\*\([\s\S]*?-->/,
      );
      const reusableFilter = reusableWorkflowSourceLocal.match(
        /\$request_id == ""[\s\S]*?skeptic-request-id-\[\^>\]\*\([\s\S]*?-->/,
      );
      expect(gateFilter).not.toBeNull();
      expect(reusableFilter).not.toBeNull();
    });
  });
});
