import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:child_process — gh CLI calls go through execFileAsync = promisify(execFile)
// vi.hoisted ensures the mock fn is available when vi.mock factory runs (hoisted above imports)
// ---------------------------------------------------------------------------
const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  // Attach the custom promisify symbol so `promisify(execFile)` returns ghMock
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

import { create, manifest, ghRestFallback } from "../src/index.js";
import { _resetGhCache } from "../src/gh-cache.js";
import type { PRInfo, SCMWebhookRequest, Session, ProjectConfig } from "@jleechanorg/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pr: PRInfo = {
  number: 42,
  url: "https://github.com/acme/repo/pull/42",
  title: "feat: add feature",
  owner: "acme",
  repo: "repo",
  branch: "feat/my-feature",
  baseBranch: "main",
  isDraft: false,
  author: "testuser",
};

const project: ProjectConfig = {
  name: "test",
  repo: "acme/repo",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: "feat/my-feature",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/repo",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function mockGh(result: unknown) {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

function mockGhError(msg = "Command failed") {
  ghMock.mockRejectedValueOnce(new Error(msg));
}

function makeWebhookRequest(overrides: Partial<SCMWebhookRequest> = {}): SCMWebhookRequest {
  return {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
    },
    body: JSON.stringify({
      action: "opened",
      repository: { owner: { login: "acme" }, name: "repo" },
      pull_request: {
        number: 42,
        updated_at: "2026-03-10T12:00:00Z",
        head: { ref: "feat/my-feature", sha: "abc123" },
      },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scm-github plugin", () => {
  let scm: ReturnType<typeof create>;

  beforeEach(() => {
    _resetGhCache();
    vi.clearAllMocks();
    ghMock.mockReset(); // clear queue + stale mockResolvedValue from previous test
    ghMock.mockResolvedValue({ stdout: "" }); // neutral base: no output for unexpected gh calls
    scm = create();
    delete process.env["GITHUB_WEBHOOK_SECRET"];
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("github");
      expect(manifest.slot).toBe("scm");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  // ---- create() ----------------------------------------------------------

  describe("create()", () => {
    it("returns an SCM with correct name", () => {
      expect(scm.name).toBe("github");
    });

    it("accepts extraBotAuthors config and includes those bots in getAutomatedComments", async () => {
      // Create SCM with custom extraBotAuthors
      const customSCM = create({ extraBotAuthors: ["custom-bot[bot]", "my-ci-bot"] });

      // Mock gh to return comments from default bots + custom bots + human
      mockGh([
        {
          id: 1,
          user: { login: "custom-bot[bot]" },
          body: "Automated check",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u1",
        },
        {
          id: 2,
          user: { login: "my-ci-bot" },
          body: "CI result",
          path: "b.ts",
          line: 2,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u2",
        },
        {
          id: 3,
          user: { login: "cursor[bot]" },
          body: "Found a potential issue",
          path: "c.ts",
          line: 3,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u3",
        },
        {
          id: 4,
          user: { login: "alice" },
          body: "Human comment",
          path: "d.ts",
          line: 4,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u4",
        },
      ]);

      // getAutomatedComments returns ONLY bot comments (filters for bots)
      const comments = await customSCM.getAutomatedComments(pr);
      // Should include custom bots + default bots, but NOT human
      expect(comments).toHaveLength(3);
      const botNames = comments.map((c) => c.botName);
      // Custom bots should be included alongside default bots
      expect(botNames).toContain("custom-bot[bot]");
      expect(botNames).toContain("my-ci-bot");
      expect(botNames).toContain("cursor[bot]");
      // Human should NOT be included
      expect(botNames).not.toContain("alice");
    });

    it("accepts extraBotAuthors config and filters those bots in getPendingComments", async () => {
      // Create SCM with custom extraBotAuthors
      const customSCM = create({ extraBotAuthors: ["review-bot[bot]"] });

      // Create mock GraphQL threads with custom bot
      const mockThreads = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: false,
                    comments: {
                      nodes: [
                        {
                          id: "C1",
                          author: { login: "review-bot[bot]" },
                          body: "Bot review",
                          path: "a.ts",
                          line: 1,
                          url: "u1",
                          createdAt: "2025-01-01T00:00:00Z",
                        },
                      ],
                    },
                  },
                  {
                    isResolved: false,
                    comments: {
                      nodes: [
                        {
                          id: "C2",
                          author: { login: "alice" },
                          body: "Human review",
                          path: "b.ts",
                          line: 2,
                          url: "u2",
                          createdAt: "2025-01-01T00:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      };

      mockGh(mockThreads);

      // getPendingComments filters OUT bots (returns only human comments)
      const comments = await customSCM.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });
  });

  describe("getSkepticVerdict", () => {
    it("returns PASS when skeptic bot posted VERDICT: PASS", async () => {
      mockGh([
        { id: 1, user: { login: "coderabbitai[bot]" }, body: "looks good" },
        {
          id: 2,
          user: { login: "jleechan-agent[bot]" },
          body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS\n\nAll exit criteria met.",
        },
      ]);
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("PASS");
      // Verify gh was called with the correct REST endpoint
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["api", expect.stringContaining("repos/acme/repo/issues/42/comments")]),
        expect.any(Object),
      );
    });

    it("returns FAIL when skeptic bot posted VERDICT: FAIL", async () => {
      mockGh([
        { id: 1, user: { login: "other-bot" }, body: "comment" },
        {
          id: 2,
          user: { login: "jleechan-agent[bot]" },
          body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL\n\nGap: missing test coverage",
        },
      ]);
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("FAIL");
    });

    it("returns SKIPPED when no skeptic verdict comment exists", async () => {
      mockGh([
        { id: 1, user: { login: "coderabbitai[bot]" }, body: "looks good" },
        { id: 2, user: { login: "human" }, body: "please review" },
      ]);
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("SKIPPED");
    });

    it("returns SKIPPED when skeptic bot exists with marker but no VERDICT line", async () => {
      mockGh([
        {
          id: 3,
          user: { login: "jleechan-agent[bot]" },
          body: "<!-- skeptic-agent-verdict -->\nRunning skeptic analysis...",
        },
      ]);
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("SKIPPED");
    });

    it("returns SKIPPED when skeptic bot has VERDICT line but no marker", async () => {
      mockGh([
        {
          id: 4,
          user: { login: "jleechan-agent[bot]" },
          body: "VERDICT: PASS\n\nAll criteria met.",
        },
      ]);
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("SKIPPED");
    });

    it("returns SKIPPED when API call fails (non-fatal)", async () => {
      mockGhError("API error");
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("SKIPPED");
    });

    it("returns SKIPPED when comments list is empty", async () => {
      mockGh([]);
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("SKIPPED");
    });

    it("uses trustedSkepticAuthors from config when provided", async () => {
      const customSCM = create({ trustedSkepticAuthors: ["custom-skeptic[bot]"] });
      mockGh([
        {
          id: 1,
          user: { login: "custom-skeptic[bot]" },
          body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS",
        },
      ]);
      const result = await customSCM.getSkepticVerdict!(pr);
      expect(result).toBe("PASS");
    });

    it("returns last (newest) verdict when skeptic posts multiple verdicts", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "jleechan-agent[bot]" },
          body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL\n\nInitial check failed",
        },
        {
          id: 2,
          user: { login: "jleechan-agent[bot]" },
          body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS\n\nAll exit criteria met.",
        },
      ]);
      // GitHub returns oldest first; last matching comment wins
      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("PASS");
    });

    it("finds skeptic verdict on second page of comments (pagination)", async () => {
      // Page 1: no skeptic comments — 100 items (exactly full page → continue)
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        user: { login: "other-bot" },
        body: `comment ${i}`,
      }));
      // Page 2: skeptic PASS verdict — fewer than 100 items → pagination stops
      const page2 = [
        { id: 101, user: { login: "jleechan-agent[bot]" }, body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS" },
      ];
      ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(page1) });
      ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(page2) });

      const result = await scm.getSkepticVerdict!(pr);
      expect(result).toBe("PASS");
    });
  });

  describe("verifyWebhook", () => {
    it("accepts unsigned webhooks when no secret is configured", async () => {
      await expect(scm.verifyWebhook?.(makeWebhookRequest(), project)).resolves.toEqual({
        ok: true,
        deliveryId: "delivery-1",
        eventType: "pull_request",
      });
    });

    it("verifies a valid HMAC signature", async () => {
      process.env["GITHUB_WEBHOOK_SECRET"] = "topsecret";
      const body = makeWebhookRequest().body;
      const signature = await import("node:crypto").then(
        ({ createHmac }) =>
          `sha256=${createHmac("sha256", "topsecret").update(body).digest("hex")}`,
      );

      const result = await scm.verifyWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-1",
            "x-hub-signature-256": signature,
          },
        }),
        {
          ...project,
          scm: { plugin: "github", webhook: { secretEnvVar: "GITHUB_WEBHOOK_SECRET" } },
        },
      );

      expect(result?.ok).toBe(true);
    });

    it("rejects an invalid HMAC signature", async () => {
      process.env["GITHUB_WEBHOOK_SECRET"] = "topsecret";

      const result = await scm.verifyWebhook?.(
        makeWebhookRequest({
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-1",
            "x-hub-signature-256": "sha256=deadbeef",
          },
        }),
        {
          ...project,
          scm: { plugin: "github", webhook: { secretEnvVar: "GITHUB_WEBHOOK_SECRET" } },
        },
      );

      expect(result).toEqual(
        expect.objectContaining({ ok: false, reason: "Webhook signature verification failed" }),
      );
    });
  });

  describe("parseWebhook", () => {
    it("parses pull_request events", async () => {
      const event = await scm.parseWebhook?.(makeWebhookRequest(), project);
      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "pull_request",
          action: "opened",
          prNumber: 42,
          branch: "feat/my-feature",
          sha: "abc123",
        }),
      );
    });

    it("omits repository when owner.login is not a string", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          body: JSON.stringify({
            action: "opened",
            repository: { owner: { login: 123 }, name: "repo" },
            pull_request: {
              number: 42,
              updated_at: "2026-03-10T12:00:00Z",
              head: { ref: "feat/my-feature", sha: "abc123" },
            },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({ kind: "pull_request", repository: undefined }),
      );
    });

    it("parses issue_comment events on pull requests as comment events", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "issue_comment" },
          body: JSON.stringify({
            action: "created",
            repository: { owner: { login: "acme" }, name: "repo" },
            issue: { number: 42, pull_request: { url: "https://api.github.com/..." } },
            comment: { updated_at: "2026-03-10T12:00:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({ provider: "github", kind: "comment", prNumber: 42 }),
      );
    });

    it("falls back to comment.created_at for issue_comment timestamps", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "issue_comment" },
          body: JSON.stringify({
            action: "created",
            repository: { owner: { login: "acme" }, name: "repo" },
            issue: { number: 42, pull_request: { url: "https://api.github.com/..." } },
            comment: { created_at: "2026-03-10T12:00:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({ provider: "github", kind: "comment", prNumber: 42 }),
      );
      expect(event?.timestamp?.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    });

    it("parses pull_request_review_comment timestamp from comment payload", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "pull_request_review_comment" },
          body: JSON.stringify({
            action: "created",
            repository: { owner: { login: "acme" }, name: "repo" },
            number: 42,
            pull_request: {
              number: 42,
              head: { ref: "feat/my-feature", sha: "abc123" },
            },
            comment: { created_at: "2026-03-10T12:00:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "comment",
          prNumber: 42,
        }),
      );
      expect(event?.timestamp?.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    });

    it("parses status events with branch info", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "status" },
          body: JSON.stringify({
            state: "failure",
            repository: { owner: { login: "acme" }, name: "repo" },
            sha: "def456",
            branches: [{ name: "feat/my-feature" }],
            updated_at: "2026-03-10T12:00:00Z",
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "ci",
          action: "failure",
          branch: "feat/my-feature",
          sha: "def456",
        }),
      );
    });

    it("parses check_run events using check_suite.head_branch", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "check_run" },
          body: JSON.stringify({
            action: "completed",
            repository: { owner: { login: "acme" }, name: "repo" },
            check_run: {
              head_sha: "def456",
              updated_at: "2026-03-10T12:00:00Z",
              pull_requests: [{ number: 42 }],
              check_suite: { head_branch: "feat/my-feature" },
            },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "ci",
          branch: "feat/my-feature",
          sha: "def456",
          prNumber: 42,
        }),
      );
    });

    it("parses push events with branch and sha", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "push" },
          body: JSON.stringify({
            ref: "refs/heads/feat/my-feature",
            after: "abcde12345",
            repository: { owner: { login: "acme" }, name: "repo" },
            head_commit: { timestamp: "2026-03-10T12:01:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "push",
          branch: "feat/my-feature",
          sha: "abcde12345",
        }),
      );
      expect(event?.timestamp?.toISOString()).toBe("2026-03-10T12:01:00.000Z");
    });

    it("does not set branch for tag push refs", async () => {
      const event = await scm.parseWebhook?.(
        makeWebhookRequest({
          headers: { "x-github-event": "push" },
          body: JSON.stringify({
            ref: "refs/tags/v1.0.0",
            after: "abcde12345",
            repository: { owner: { login: "acme" }, name: "repo" },
            head_commit: { timestamp: "2026-03-10T12:01:00Z" },
          }),
        }),
        project,
      );

      expect(event).toEqual(
        expect.objectContaining({
          provider: "github",
          kind: "push",
          branch: undefined,
          sha: "abcde12345",
        }),
      );
    });
  });

  // ---- detectPR ----------------------------------------------------------

  describe("detectPR", () => {
    it("returns PRInfo when a PR exists (GraphQL primary path)", async () => {
      // gh pr list --head (GraphQL) returns headRefName/baseRefName/isDraft
      mockGh([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "feat: add feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: false,
          author: null,
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "feat: add feature",
        owner: "acme",
        repo: "repo",
        branch: "feat/my-feature",
        baseBranch: "main",
        isDraft: false,
        author: null,
      });
    });

    it("returns null when no PR found", async () => {
      // GraphQL succeeds with empty array — no REST call needed
      mockGh([]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("GraphQL-primary: returns PR from gh pr list when found", async () => {
      // gh pr list --head (GraphQL) finds the PR directly
      mockGh([
        {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          title: "feat: add feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: false,
          author: { login: "testuser" },
        },
      ]);

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual(pr);
      expect(ghMock).toHaveBeenNthCalledWith(
        1,
        "gh",
        [
          "pr",
          "list",
          "--repo",
          "acme/repo",
          "--head",
          "feat/my-feature",
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft,author",
          "--limit",
          "1",
        ],
        expect.any(Object),
      );
    });

    it("REST fallback when GraphQL fails (rate-limit / network error)", async () => {
      // mockImplementation gives precise control over each gh call:
      // Call 1 (gh pr list --head, attempt 1): throw rate-limit → retry
      // Call 2 (retry attempt 2): throw rate-limit → retry
      // Call 3 (retry attempt 3): throw rate-limit → retries exhausted → throws
      // Call 4 (REST fallback, gh api ...): return PR data → success
      let callCount = 0;
      ghMock.mockImplementation(() => {
        callCount++;
        if (callCount <= 3) {
          return Promise.reject(new Error("API rate limit exceeded"));
        }
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              number: 42,
              html_url: "https://github.com/acme/repo/pull/42",
              title: "feat: add feature",
              head: { ref: "feat/my-feature" },
              base: { ref: "main" },
              draft: false,
              user: { login: "testuser" },
            },
          ]),
        });
      });

      const result = await scm.detectPR(makeSession(), project);
      expect(result).toEqual(pr);
      expect(callCount).toBe(4);
    });

    it("returns null when both GraphQL and REST fail", async () => {
      mockGhError("gh: not found");
      mockGhError("network error");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("returns null when session has no branch", async () => {
      const result = await scm.detectPR(makeSession({ branch: null }), project);
      expect(result).toBeNull();
      expect(ghMock).not.toHaveBeenCalled();
    });

    it("returns null on gh CLI error", async () => {
      mockGhError("gh: not found");
      const result = await scm.detectPR(makeSession(), project);
      expect(result).toBeNull();
    });

    it("throws on invalid repo format", async () => {
      const badProject = { ...project, repo: "no-slash" };
      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow("Invalid repo format");
    });

    it("rejects repo strings with extra path segments", async () => {
      const badProject = { ...project, repo: "acme/repo/extra" };
      await expect(scm.detectPR(makeSession(), badProject)).rejects.toThrow("Invalid repo format");
    });

    it("detects draft PRs", async () => {
      // GraphQL primary path: gh pr list --head returns isDraft
      mockGh([
        {
          number: 99,
          url: "https://github.com/acme/repo/pull/99",
          title: "WIP: draft feature",
          headRefName: "feat/my-feature",
          baseRefName: "main",
          isDraft: true,
        },
      ]);
      const result = await scm.detectPR(makeSession(), project);
      expect(result?.isDraft).toBe(true);
    });

    it("resolves PR by reference", async () => {
      // REST API format
      mockGh({
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "feat: add feature",
        head: { ref: "feat/my-feature" },
        base: { ref: "main" },
        draft: false,
        user: { login: "testuser" },
      });

      const result = await scm.resolvePR?.("42", project);
      expect(result).toEqual(pr);
    });

    it("assigns PR to current user", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.assignPRToCurrentUser?.(pr);
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "edit", "42", "--repo", "acme/repo", "--add-assignee", "@me"],
        expect.any(Object),
      );
    });

    it("checks out PR when workspace is clean and branch differs", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "main\n" }); // git branch --show-current (before)
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git status --porcelain (clean)
      ghMock.mockResolvedValueOnce({ stdout: "https://github.com/acme/repo.git\n" }); // git remote get-url origin
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git fetch refs/pull/42/head:feat/my-feature (primary succeeds)
      ghMock.mockResolvedValueOnce({ stdout: "main\n" }); // git branch --show-current (after fetch — still on main)
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git checkout feat/my-feature
      ghMock.mockResolvedValueOnce({ stdout: "feat/my-feature\n" }); // git branch --show-current (verify)

      const changed = await scm.checkoutPR?.(pr, "/tmp/repo");
      expect(changed).toBe(true);
    });

    it("throws when git fetch fails for non-ref-not-found reasons (auth, network)", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "main\n" }); // git branch --show-current (before)
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git status --porcelain (clean)
      ghMock.mockResolvedValueOnce({ stdout: "https://github.com/acme/repo.git\n" }); // git remote get-url origin
      ghMock.mockRejectedValueOnce(new Error("Authentication failed")); // git fetch fails with auth error

      await expect(scm.checkoutPR?.(pr, "/tmp/repo")).rejects.toThrow("Authentication failed");
    });

    it("returns true when git fetch + checkout succeeds (already on branch after fetch)", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "main\n" }); // git branch --show-current (before)
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git status --porcelain (clean)
      ghMock.mockResolvedValueOnce({ stdout: "https://github.com/acme/repo.git\n" }); // git remote get-url origin
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git fetch refs/pull/42/head:feat/my-feature (primary succeeds)
      ghMock.mockResolvedValueOnce({ stdout: "main\n" }); // git branch --show-current (after fetch — still on main, needs checkout)
      ghMock.mockResolvedValueOnce({ stdout: "" }); // git checkout feat/my-feature
      ghMock.mockResolvedValueOnce({ stdout: "feat/my-feature\n" }); // git branch --show-current (verify)

      const changed = await scm.checkoutPR?.(pr, "/tmp/repo");
      expect(changed).toBe(true);
    });

    it("returns false without error when workspace is already on the PR branch", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "feat/my-feature\n" }); // git branch --show-current (already on PR branch)
      // No dirty check, no checkout, no post-checkout verification

      const changed = await scm.checkoutPR?.(pr, "/tmp/repo");
      expect(changed).toBe(false);
    });

    it("throws when workspace has uncommitted changes", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "main\n" }); // git branch --show-current
      ghMock.mockResolvedValueOnce({ stdout: "M  src/foo.ts\n" }); // git status --porcelain (dirty)
      // No checkout attempt

      await expect(scm.checkoutPR?.(pr, "/tmp/repo")).rejects.toThrow(
        "Workspace has uncommitted changes",
      );
    });
  });

  // ---- getPRState --------------------------------------------------------

  describe("getPRState", () => {
    it('returns "open" for open PR', async () => {
      mockGh({ state: "OPEN" });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it('returns "merged" for merged PR', async () => {
      mockGh({ state: "MERGED" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });

    it('returns "closed" for closed PR', async () => {
      mockGh({ state: "CLOSED" });
      expect(await scm.getPRState(pr)).toBe("closed");
    });

    it("handles lowercase state strings", async () => {
      mockGh({ state: "merged" });
      expect(await scm.getPRState(pr)).toBe("merged");
    });

    it("falls back to REST API when GraphQL is rate-limited", async () => {
      // Exhaust all 3 retries with rate limit errors
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // REST fallback: gh api repos/acme/repo/pulls/42
      mockGh({ state: "open", merged: false });
      expect(await scm.getPRState(pr)).toBe("open");
    });

    it("REST fallback returns merged when merged=true", async () => {
      // Exhaust all 3 retries with rate limit errors
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // REST API returns {state: "closed", merged: true} for merged PRs
      mockGh({ state: "closed", merged: true });
      expect(await scm.getPRState(pr)).toBe("merged");
    });
  });

  // ---- getPRSummary REST fallback -----------------------------------------

  describe("getPRSummary REST fallback", () => {
    it("falls back to REST API when GraphQL is rate-limited", async () => {
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // REST fallback returns full PR object
      mockGh({ state: "open", merged: false, title: "Fix bug", additions: 10, deletions: 5 });
      const summary = await scm.getPRSummary(pr);
      expect(summary).toMatchObject({ state: "open", title: "Fix bug", additions: 10, deletions: 5 });
    });

    it("REST fallback correctly identifies merged PRs", async () => {
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGh({ state: "closed", merged: true, title: "Feature", additions: 100, deletions: 20 });
      const summary = await scm.getPRSummary(pr);
      expect(summary.state).toBe("merged");
    });
  });

  // ---- getReviewDecision REST fallback ------------------------------------
  // All tests here mock setTimeout so retry sleeps resolve immediately.

  describe("getReviewDecision REST fallback", () => {
    let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((cb: () => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      });
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it("returns pending when REST synthesizes from pull + reviews (empty reviews = conservative)", async () => {
      // ghWithRetry: 3 retries on gh pr view, then REST fallback
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGh({ state: "open", merged: false });
      // Reviews retry loop: 1 rate-limit (sleeps 1s, mocked), then succeeds
      mockGhError("API rate limit exceeded");
      mockGh([]);
      expect(await scm.getReviewDecision(pr)).toBe("pending");
      expect(ghMock).toHaveBeenNthCalledWith(
        4,
        "gh",
        ["api", "repos/acme/repo/pulls/42"],
        expect.any(Object),
      );
      expect(ghMock).toHaveBeenNthCalledWith(
        5,
        "gh",
        ["api", "repos/acme/repo/pulls/42/reviews", "--paginate"],
        expect.any(Object),
      );
    });

    // bd-77b: COMMENTED reviews after APPROVED should NOT block merge gate.
    // CodeRabbit posts incremental COMMENTED reviews that supersede its earlier
    // APPROVED in chronological order. The REST fallback must treat COMMENTED as
    // non-decisive so an earlier APPROVED still counts as the decision.
    it("returns approved when CR COMMENTED review is newer than APPROVED review (bd-77b)", async () => {
      // GraphQL rate-limit → triggers REST fallback
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // REST: gh api repos/{owner}/{repo}/pulls/{pr}
      mockGh({ state: "open", merged: false });
      // Reviews retry loop: 1 rate-limit (sleeps 1s, mocked), then succeeds with CR reviews
      mockGhError("API rate limit exceeded");
      // REST: gh api repos/{owner}/{repo}/pulls/{pr}/reviews
      // CodeRabbit APPROVED first, then posted a COMMENTED review later.
      mockGh([
        {
          state: "APPROVED",
          user: { login: "coderabbitai[bot]" },
          body: "Looks good!",
          submitted_at: "2026-03-20T10:00:00Z",
        },
        {
          state: "COMMENTED",
          user: { login: "coderabbitai[bot]" },
          body: "Minor suggestion (non-blocking)",
          submitted_at: "2026-03-20T11:00:00Z",
        },
      ]);
      expect(await scm.getReviewDecision(pr)).toBe("approved");
    });

    // bd-yo1: when both gh pr view and the REST fallback's reviews call rate-limit,
    // deriveReviewDecisionGraphqlFromReviews returns REVIEW_REQUIRED → "pending".
    // This is the correct conservative fallback (previously the rate-limit on
    // gh pr view was caught and "none" was returned, short-circuiting the REST path).
    it("returns pending when REST fallback reviews endpoint also rate-limits", async () => {
      // ghWithRetry: 3 retries on gh pr view, then REST fallback
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // ghWithRetry REST fallback: gh api repos/.../pulls/42
      mockGh({ state: "open", merged: false });
      // fetchPrViewFallbackAsJson reviews retry loop: all 3 attempts rate-limit
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded"); // 3rd attempt → throws, caught → REVIEW_REQUIRED
      expect(await scm.getReviewDecision(pr)).toBe("pending");
    });
  });

  // ---- mergePR -----------------------------------------------------------

  describe("mergePR", () => {
    it("uses --squash by default", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr);
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "merge", "42", "--repo", "acme/repo", "--squash", "--delete-branch"],
        expect.any(Object),
      );
    });

    it("uses --merge when specified", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "merge");
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["--merge"]),
        expect.any(Object),
      );
    });

    it("uses --rebase when specified", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.mergePR(pr, "rebase");
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["--rebase"]),
        expect.any(Object),
      );
    });

    it("REST fallback branch deletion preserves slashes in branch name", async () => {
      // ghWithRetry retries 3x on rate-limit errors before giving up.
      // Exhaust all 3 retries so mergePR's REST fallback path is reached.
      for (let i = 0; i < 3; i++) {
        ghMock.mockRejectedValueOnce(new Error("HTTP 403: GraphQL API rate limit exceeded"));
      }
      // execFileAsync("curl", ...) → HTTP 200 merge response
      ghMock.mockResolvedValueOnce({ stdout: '{"merged": true}\n200' });

      process.env.GITHUB_TOKEN = "test-token";
      await scm.mergePR(pr);
      delete process.env["GITHUB_TOKEN"];

      // Verify the branch deletion gh api call uses slashes, not %2F.
      // execFileAsync(bin, args) → ghMock call: call[0]=bin, call[1]=args[]
      const deleteCall = (ghMock as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => Array.isArray(call[1]) && call[1].includes("DELETE"),
      );
      expect(deleteCall).toBeDefined();
      const deleteArgs = deleteCall![1] as string[];
      // args: ["api", "repos/acme/repo/git/refs/heads/feat/my-feature", "--method", "DELETE"]
      expect(deleteArgs.join(" ")).toContain("refs/heads/feat/my-feature");
      expect(deleteArgs.join(" ")).not.toContain("%2F");
    });
  });

  // ---- closePR -----------------------------------------------------------

  describe("closePR", () => {
    it("calls gh pr close", async () => {
      ghMock.mockResolvedValueOnce({ stdout: "" });
      await scm.closePR(pr);
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "close", "42", "--repo", "acme/repo"],
        expect.any(Object),
      );
    });
  });

  // ---- getCIChecks -------------------------------------------------------

  describe("getCIChecks", () => {
    it("maps various check states correctly", async () => {
      mockGh([
        {
          name: "build",
          state: "SUCCESS",
          link: "https://ci/1",
          startedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:05:00Z",
        },
        { name: "lint", state: "FAILURE", link: "", startedAt: "", completedAt: "" },
        { name: "deploy", state: "PENDING", link: "", startedAt: "", completedAt: "" },
        { name: "e2e", state: "IN_PROGRESS", link: "", startedAt: "", completedAt: "" },
        { name: "optional", state: "SKIPPED", link: "", startedAt: "", completedAt: "" },
        { name: "neutral", state: "NEUTRAL", link: "", startedAt: "", completedAt: "" },
        { name: "timeout", state: "TIMED_OUT", link: "", startedAt: "", completedAt: "" },
        { name: "queued", state: "QUEUED", link: "", startedAt: "", completedAt: "" },
        { name: "cancelled", state: "CANCELLED", link: "", startedAt: "", completedAt: "" },
        { name: "action_req", state: "ACTION_REQUIRED", link: "", startedAt: "", completedAt: "" },
      ]);

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(10);
      expect(checks[0].status).toBe("passed");
      expect(checks[0].url).toBe("https://ci/1");
      expect(checks[1].status).toBe("failed");
      expect(checks[2].status).toBe("pending");
      expect(checks[3].status).toBe("running");
      expect(checks[4].status).toBe("skipped");
      expect(checks[5].status).toBe("skipped");
      expect(checks[6].status).toBe("failed");
      expect(checks[7].status).toBe("pending");
      expect(checks[8].status).toBe("failed"); // CANCELLED
      expect(checks[9].status).toBe("failed"); // ACTION_REQUIRED
    });

    it("throws on error (fail-closed)", async () => {
      mockGhError("no checks");
      await expect(scm.getCIChecks(pr)).rejects.toThrow("Failed to fetch CI checks");
    });

    it("returns empty array for PR with no checks", async () => {
      mockGh([]);
      expect(await scm.getCIChecks(pr)).toEqual([]);
    });

    it("handles missing optional fields gracefully", async () => {
      mockGh([{ name: "test", state: "SUCCESS" }]);
      const checks = await scm.getCIChecks(pr);
      expect(checks[0].url).toBeUndefined();
      expect(checks[0].startedAt).toBeUndefined();
      expect(checks[0].completedAt).toBeUndefined();
    });

    it("falls back to REST check-runs when rate-limited on statusCheckRollup", async () => {
      // First call: gh pr checks fails (unsupported)
      mockGhError("gh pr checks failed: unknown json field 'state'");
      // Second call: gh pr view --json statusCheckRollup => rate limit (3 retries)
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // REST fallback: gh api repos/acme/repo/pulls/42
      mockGh({
        state: "open",
        head: { sha: "abc123", ref: "feat/test" },
        base: { ref: "main" },
      });
      // REST fallback: gh api repos/acme/repo/commits/abc123/check-runs --paginate
      // (fetchCheckRunsViaRest uses --paginate to read all pages)
      mockGh({
        check_runs: [
          { name: "build", status: "completed", conclusion: "success", html_url: "https://ci/1" },
          { name: "lint", status: "completed", conclusion: "failure", html_url: "https://ci/2" },
        ],
      });

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({ name: "build", status: "passed" });
      expect(checks[1]).toMatchObject({ name: "lint", status: "failed" });
    });

    it("falls back to statusCheckRollup when pr checks json is unsupported", async () => {
      mockGhError("gh pr checks failed: unknown json field 'state'");
      mockGh({
        statusCheckRollup: [
          {
            name: "build",
            state: "SUCCESS",
            detailsUrl: "https://ci/1",
            startedAt: "2025-01-01T00:00:00Z",
            completedAt: "2025-01-01T00:01:00Z",
          },
        ],
      });

      const checks = await scm.getCIChecks(pr);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "build", status: "passed" });
    });
  });

  // ---- getCISummary ------------------------------------------------------

  describe("getCISummary", () => {
    it('returns "failing" when any check failed', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "FAILURE" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "pending" when checks are running', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "IN_PROGRESS" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("pending");
    });

    it('returns "passing" when all checks passed', async () => {
      mockGh([
        { name: "a", state: "SUCCESS" },
        { name: "b", state: "SUCCESS" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("passing");
    });

    it('returns "none" when no checks', async () => {
      mockGh([]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it('returns "failing" on error (fail-closed)', async () => {
      mockGhError();
      expect(await scm.getCISummary(pr)).toBe("failing");
    });

    it('returns "none" when all checks are skipped', async () => {
      mockGh([
        { name: "a", state: "SKIPPED" },
        { name: "b", state: "NEUTRAL" },
      ]);
      expect(await scm.getCISummary(pr)).toBe("none");
    });

    it(
      "returns 'none' when all retries hit rate limits and secondary fallback also fails",
      async () => {
        // getCIChecks: gh pr checks rate-limited (4 retries = 4 calls)
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        // getCIChecksFromStatusRollup: gh pr view rate-limited (4 retries = 4 calls)
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        // getCISummary catches secondary fallback failure → returns "none"
        await expect(scm.getCISummary(pr)).resolves.toEqual("none");
      },
      120000, // ghWithRetry: 3 retries × up to 30s backoff; 8 errors ≈ 56s total
    );

    it(
      "returns 'passing' when getCIChecks hits rate limit but REST fallback succeeds",
      async () => {
        // getCIChecks: gh pr checks rate-limited (4 retries = 4 calls)
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        // getCIChecksFromStatusRollup: gh pr view rate-limited (4 retries = 4 calls)
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        // REST fallback: gh api repos/acme/repo/pulls/42
        mockGh({
          state: "open",
          head: { sha: "abc123", ref: "feat/test" },
          base: { ref: "main" },
        });
        // REST fallback: fetchCheckRunsViaRest → gh api repos/acme/repo/commits/abc123/check-runs --paginate
        mockGh({
          check_runs: [
            { name: "build", status: "completed", conclusion: "success", html_url: "https://ci/1" },
            { name: "lint", status: "completed", conclusion: "success", html_url: "https://ci/2" },
          ],
        });

        await expect(scm.getCISummary(pr)).resolves.toEqual("passing");
      },
      120000, // ghWithRetry: 3 retries × up to 30s backoff; 8 errors ≈ 56s total
    );

    it(
      "returns 'failing' when getCIChecks hits rate limit but REST fallback returns failing checks",
      async () => {
        // getCIChecks: gh pr checks rate-limited (4 retries = 4 calls)
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        // getCIChecksFromStatusRollup: gh pr view rate-limited (4 retries = 4 calls)
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        mockGhError("API rate limit exceeded");
        // REST fallback: gh api repos/acme/repo/pulls/42
        mockGh({
          state: "open",
          head: { sha: "abc123", ref: "feat/test" },
          base: { ref: "main" },
        });
        // REST fallback: fetchCheckRunsViaRest → gh api repos/acme/repo/commits/abc123/check-runs --paginate
        mockGh({
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "lint", status: "completed", conclusion: "failure" },
          ],
        });

        await expect(scm.getCISummary(pr)).resolves.toEqual("failing");
      },
      120000, // ghWithRetry: 3 retries × up to 30s backoff; 8 errors ≈ 56s total
    );
  });

  // ---- getReviews --------------------------------------------------------

  describe("getReviews", () => {
    it("maps review states correctly", async () => {
      mockGh({
        reviews: [
          {
            author: { login: "alice" },
            state: "APPROVED",
            body: "LGTM",
            submittedAt: "2025-01-01T00:00:00Z",
          },
          {
            author: { login: "bob" },
            state: "CHANGES_REQUESTED",
            body: "Fix this",
            submittedAt: "2025-01-02T00:00:00Z",
          },
          {
            author: { login: "charlie" },
            state: "COMMENTED",
            body: "",
            submittedAt: "2025-01-03T00:00:00Z",
          },
          {
            author: { login: "eve" },
            state: "DISMISSED",
            body: "",
            submittedAt: "2025-01-04T00:00:00Z",
          },
          { author: { login: "frank" }, state: "PENDING", body: "", submittedAt: null },
        ],
      });

      const reviews = await scm.getReviews(pr);
      expect(reviews).toHaveLength(5);
      expect(reviews[0]).toMatchObject({ author: "alice", state: "approved" });
      expect(reviews[1]).toMatchObject({ author: "bob", state: "changes_requested" });
      expect(reviews[2]).toMatchObject({ author: "charlie", state: "commented" });
      expect(reviews[3]).toMatchObject({ author: "eve", state: "dismissed" });
      expect(reviews[4]).toMatchObject({ author: "frank", state: "pending" });
    });

    it("handles empty reviews", async () => {
      mockGh({ reviews: [] });
      expect(await scm.getReviews(pr)).toEqual([]);
    });

    it('defaults to "unknown" author when missing', async () => {
      mockGh({
        reviews: [
          { author: null, state: "APPROVED", body: "", submittedAt: "2025-01-01T00:00:00Z" },
        ],
      });
      const reviews = await scm.getReviews(pr);
      expect(reviews[0].author).toBe("unknown");
    });
  });

  describe("getReviews REST fallback", () => {
    let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((cb: () => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      });
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it("returns empty array when REST fallback has no reviews field", async () => {
      // ghWithRetry: 3 retries on gh pr view, then REST fallback
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // REST fallback gh api repos/.../pulls/42
      mockGh({ state: "open", merged: false });
      // Reviews retry loop: 1 rate-limit (sleeps 1s, mocked), then succeeds with []
      mockGhError("API rate limit exceeded");
      mockGh([]);
      expect(await scm.getReviews(pr)).toEqual([]);
    });

    // bd-yo1: even when gh pr view rate-limits, the REST fallback should still
    // invoke gh api .../reviews. If that also rate-limits, throw so the caller
    // (determineStatus) can handle it rather than silently returning [].
    it("throws when REST fallback reviews endpoint also rate-limits", async () => {
      // ghWithRetry: 3 retries on gh pr view, then REST fallback
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      // ghWithRetry REST fallback: gh api repos/.../pulls/42
      mockGh({ state: "open", merged: false });
      // fetchPrViewFallbackAsJson reviews retry loop: all 3 attempts rate-limit
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded");
      mockGhError("API rate limit exceeded"); // 3rd attempt → throws
      await expect(scm.getReviews(pr)).rejects.toThrow("API rate limit exceeded");
    });
  });

  // ---- getReviewDecision -------------------------------------------------

  describe("getReviewDecision", () => {
    it.each([
      ["APPROVED", "approved"],
      ["CHANGES_REQUESTED", "changes_requested"],
      ["REVIEW_REQUIRED", "pending"],
    ] as const)('maps %s to "%s"', async (input, expected) => {
      mockGh({ reviewDecision: input });
      expect(await scm.getReviewDecision(pr)).toBe(expected);
    });

    it('returns "none" when reviewDecision is empty', async () => {
      mockGh({ reviewDecision: "" });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });

    it('returns "none" when reviewDecision is null', async () => {
      mockGh({ reviewDecision: null });
      expect(await scm.getReviewDecision(pr)).toBe("none");
    });

    it("throws on non-rate-limit gh failure (fail-closed)", async () => {
      mockGhError("gh crashed");
      await expect(scm.getReviewDecision(pr)).rejects.toThrow("gh crashed");
    });
  });

  // ---- getPendingComments ------------------------------------------------

  describe("getPendingComments", () => {
    function makeGraphQLThreads(
      threads: Array<{
        isResolved: boolean;
        id: string;
        author: string | null;
        body: string;
        path: string | null;
        line: number | null;
        url: string;
        createdAt: string;
      }>,
    ) {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: threads.map((t) => ({
                  isResolved: t.isResolved,
                  comments: {
                    nodes: [
                      {
                        id: t.id,
                        author: t.author ? { login: t.author } : null,
                        body: t.body,
                        path: t.path,
                        line: t.line,
                        url: t.url,
                        createdAt: t.createdAt,
                      },
                    ],
                  },
                })),
              },
            },
          },
        },
      };
    }

    it("returns only unresolved non-bot comments from GraphQL", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "Fix line 10",
            path: "src/foo.ts",
            line: 10,
            url: "https://github.com/c/1",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: true,
            id: "C2",
            author: "bob",
            body: "Resolved one",
            path: "src/bar.ts",
            line: 20,
            url: "https://github.com/c/2",
            createdAt: "2025-01-02T00:00:00Z",
          },
        ]),
      );

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ id: "C1", author: "alice", isResolved: false });
    });

    it("filters out bot comments", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "Fix this",
            path: "a.ts",
            line: 1,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: false,
            id: "C2",
            author: "cursor[bot]",
            body: "Bot says",
            path: "a.ts",
            line: 2,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
          {
            isResolved: false,
            id: "C3",
            author: "codecov[bot]",
            body: "Coverage",
            path: "a.ts",
            line: 3,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );

      const comments = await scm.getPendingComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("alice");
    });

    it("REST fallback when GraphQL fails with rate-limit error", async () => {
      // ghWithRetry retries up to maxRetries=3 times on rate-limit errors before exhausting
      // and rethrowing. Mock setTimeout to avoid real sleep delays in tests.
      const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((cb: () => void) => {
        (cb as () => void)();
        return 0 as unknown as NodeJS.Timeout;
      });
      // 3 GraphQL attempts (one per ghWithRetry attempt) all fail with rate-limit
      mockGhError("API rate limit");
      mockGhError("API rate limit");
      mockGhError("API rate limit");
      // Call 4 (REST pulls comments): return inline review comments
      mockGh([
        {
          id: 1,
          user: { login: "reviewer1" },
          body: "Please fix this",
          path: "src/foo.ts",
          line: 10,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "https://github.com/acme/repo/pull/42#discussion_r1",
        },
      ]);
      // Call 5 (REST issue comments): return empty
      mockGh([]);

      const comments = await scm.getPendingComments(pr);
      setTimeoutSpy.mockRestore();
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        id: "1",
        author: "reviewer1",
        body: "Please fix this",
        isResolved: false, // REST has no isResolved — always false
      });
    });

    it("throws on non-rate-limit error", async () => {
      mockGhError("gh: not found");
      await expect(scm.getPendingComments(pr)).rejects.toThrow("Failed to fetch pending comments");
    });

    it("handles null path and line", async () => {
      mockGh(
        makeGraphQLThreads([
          {
            isResolved: false,
            id: "C1",
            author: "alice",
            body: "General comment",
            path: null,
            line: null,
            url: "u",
            createdAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );
      const comments = await scm.getPendingComments(pr);
      expect(comments[0].path).toBeUndefined();
      expect(comments[0].line).toBeUndefined();
    });
  });

  // ---- getAutomatedComments ----------------------------------------------

  describe("getAutomatedComments", () => {
    it("uses explicit GET query for pulls comments and paginates", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        user: { login: "cursor[bot]" },
        body: "Potential issue detected",
        path: "a.ts",
        line: i + 1,
        original_line: null,
        created_at: "2025-01-01T00:00:00Z",
        html_url: `u${i + 1}`,
      }));

      const page2 = [
        {
          id: 101,
          user: { login: "cursor[bot]" },
          body: "Warning: check this",
          path: "b.ts",
          line: 7,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u101",
        },
      ];

      mockGh(page1);
      mockGh(page2);

      const comments = await scm.getAutomatedComments(pr);

      expect(comments).toHaveLength(101);
      expect(ghMock).toHaveBeenNthCalledWith(
        1,
        "gh",
        ["api", "--method", "GET", "repos/acme/repo/pulls/42/comments?per_page=100&page=1"],
        expect.any(Object),
      );
      expect(ghMock).toHaveBeenNthCalledWith(
        2,
        "gh",
        ["api", "--method", "GET", "repos/acme/repo/pulls/42/comments?per_page=100&page=2"],
        expect.any(Object),
      );
    });

    it("returns bot comments filtered from all PR comments", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "cursor[bot]" },
          body: "Found a potential issue",
          path: "a.ts",
          line: 5,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u1",
        },
        {
          id: 2,
          user: { login: "alice" },
          body: "Human comment",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u2",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(1);
      expect(comments[0].botName).toBe("cursor[bot]");
      expect(comments[0].severity).toBe("error"); // "potential issue" → error
    });

    it("classifies severity from body content", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "github-actions[bot]" },
          body: "Error: build failed",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
        {
          id: 2,
          user: { login: "github-actions[bot]" },
          body: "Warning: deprecated API",
          path: "a.ts",
          line: 2,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
        {
          id: 3,
          user: { login: "github-actions[bot]" },
          body: "Deployed to staging",
          path: "a.ts",
          line: 3,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(3);
      expect(comments[0].severity).toBe("error");
      expect(comments[1].severity).toBe("warning");
      expect(comments[2].severity).toBe("info");
    });

    it("returns empty when no bot comments", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "alice" },
          body: "Human comment",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toEqual([]);
    });

    it("throws on error", async () => {
      mockGhError("network failure");
      await expect(scm.getAutomatedComments(pr)).rejects.toThrow(
        "Failed to fetch automated comments",
      );
    });

    it("does not classify non-critical: as error (only line-start critical:)", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "github-actions[bot]" },
          // "non-critical:" is NOT a direct error report; the `critical:` pattern must be
          // at line-start to avoid false-positives on negations like "non-critical:".
          // No error pattern matches and no warning pattern matches → defaults to info.
          body: "The build succeeded but non-critical: lint warnings were emitted",
          path: "a.ts",
          line: 1,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
        {
          id: 2,
          user: { login: "github-actions[bot]" },
          // Line-start "critical:" IS a direct error report → error
          body: "critical: unable to resolve dependencies",
          path: "b.ts",
          line: 2,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
        {
          id: 3,
          user: { login: "github-actions[bot]" },
          // Line-start "warning:" IS a direct warning report → warning
          body: "warning: deprecation notice — /api/v1 is deprecated",
          path: "c.ts",
          line: 3,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(3);
      // "non-critical:" is a negation, no warning pattern matches → info
      expect(comments[0].severity).toBe("info");
      // "critical:" at line-start IS a direct error report → error
      expect(comments[1].severity).toBe("error");
      // "warning:" at line-start IS a direct warning report → warning
      expect(comments[2].severity).toBe("warning");
    });

    it("does not false-positive on incidental severity keywords in long comments", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "cursor[bot]" },
          // "High Severity" and "bug" appear but this is a Bugbot analysis comment,
          // not a direct error report. The word "bug" appears in "Bugbot" and in
          // descriptive text, not as a severity label.
          body: "### Filter uses pre-repair status causing cross-call inconsistency\n\n**Medium Severity**\n\n<!-- DESCRIPTION START -->\nThe filter looks up the original status which may cause a bug in error handling paths. Using the repaired status would avoid this issue.",
          path: "a.ts",
          line: 10,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u1",
        },
        {
          id: 2,
          user: { login: "cursor[bot]" },
          // "High Severity" header but no actual error-level keyword in severity position
          body: "### Spurious all_complete reaction fires\n\n**High Severity**\n\n<!-- DESCRIPTION START -->\nRemoving the sessions.length > 0 guard means the reaction fires with no sessions.",
          path: "b.ts",
          line: 20,
          original_line: null,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u2",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments).toHaveLength(2);
      // Bugbot "Medium/High Severity" headers should map to warning, not error
      expect(comments[0].severity).toBe("warning");
      expect(comments[1].severity).toBe("warning");
    });

    it("uses original_line as fallback", async () => {
      mockGh([
        {
          id: 1,
          user: { login: "dependabot[bot]" },
          body: "Suggest update",
          path: "a.ts",
          line: null,
          original_line: 15,
          created_at: "2025-01-01T00:00:00Z",
          html_url: "u",
        },
      ]);

      const comments = await scm.getAutomatedComments(pr);
      expect(comments[0].line).toBe(15);
    });
  });

  // ---- getMergeability ---------------------------------------------------

  describe("getMergeability", () => {
    it("returns clean result for merged PRs without querying mergeable status", async () => {
      // getPRState call
      mockGh({ state: "MERGED" });

      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
      // Should only call gh once (for getPRState), not for mergeable/CI
      expect(ghMock).toHaveBeenCalledTimes(1);
    });

    it("still checks mergeability for closed PRs (not merged)", async () => {
      // getPRState call
      mockGh({ state: "CLOSED" });
      // PR view (closed PRs still get checked)
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DIRTY",
        isDraft: false,
      });
      // CI checks
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
      // Closed PRs go through normal checks, unlike merged PRs
    });

    it("returns mergeable when everything is clear", async () => {
      // getPRState call (for open PR)
      mockGh({ state: "OPEN" });
      // PR view
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      // CI checks (called by getCISummary)
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result).toEqual({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      });
    });

    it("reports CI failures as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "FAILURE" }]);

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toContain("CI is failing");
      expect(result.blockers).toContain("Required checks are failing");
    });

    it("reports UNSTABLE merge state even when CI fetch fails", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "UNSTABLE",
        isDraft: false,
      });
      mockGhError("ENOTFOUND github.com");

      const result = await scm.getMergeability(pr);
      expect(result.ciPassing).toBe(false);
      expect(result.mergeable).toBe(false);
      expect(result.blockers).toContain("CI is failing");
      expect(result.blockers).toContain("Required checks are failing");
    });

    it("treats rate-limited CI as passing (none) to avoid spurious reactions", async () => {
      mockGh({ state: "OPEN" });
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      // getCIChecks -> gh pr checks fails with rate limit (3 retries exhausted, no fallback)
      // getCISummary catches rate limit and returns "none"
      for (let i = 0; i < 3; i++) {
        mockGhError("API rate limit exceeded");
      }

      const result = await scm.getMergeability(pr);
      // Rate-limited CI is treated as "none" (passing) — the lifecycle poller
      // retries next cycle rather than spamming "CI is failing" reactions.
      expect(result.ciPassing).toBe(true);
      expect(result.blockers.some((b) => b.includes("rate limited"))).toBe(false);
    });

    it("reports changes requested as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([]); // no CI checks

      const result = await scm.getMergeability(pr);
      expect(result.approved).toBe(false);
      expect(result.blockers).toContain("Changes requested in review");
    });

    it("reports review required as blocker", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BLOCKED",
        isDraft: false,
      });
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("Review required");
    });

    it("reports merge conflicts as blockers", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DIRTY",
        isDraft: false,
      });
      mockGh([]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });

    it("reports UNKNOWN mergeable as noConflicts false", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "UNKNOWN",
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        isDraft: false,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge status unknown (GitHub is computing)");
      expect(result.mergeable).toBe(false);
    });

    it("reports draft status as blocker", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        mergeStateStatus: "DRAFT",
        isDraft: true,
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toContain("PR is still a draft");
      expect(result.mergeable).toBe(false);
    });

    it("reports multiple blockers simultaneously", async () => {
      mockGh({ state: "OPEN" }); // getPRState
      mockGh({
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "DIRTY",
        isDraft: true,
      });
      mockGh([{ name: "build", state: "FAILURE" }]);

      const result = await scm.getMergeability(pr);
      expect(result.blockers).toHaveLength(4);
      expect(result.mergeable).toBe(false);
    });
  });

  describe("getMergeability REST-shaped payload", () => {
    it("handles boolean mergeable + mergeable_state + draft like REST GET /pulls/{n}", async () => {
      mockGh({ state: "OPEN" });
      mockGh({
        mergeable: true,
        mergeable_state: "clean",
        draft: false,
        reviewDecision: "APPROVED",
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(true);
      expect(result.blockers).not.toContain("Merge status unknown (GitHub is computing)");
    });

    it("handles mergeable=false from REST as conflicts", async () => {
      mockGh({ state: "OPEN" });
      mockGh({
        mergeable: false,
        mergeable_state: "dirty",
        draft: false,
        reviewDecision: "APPROVED",
      });
      mockGh([{ name: "build", state: "SUCCESS" }]);

      const result = await scm.getMergeability(pr);
      expect(result.noConflicts).toBe(false);
      expect(result.blockers).toContain("Merge conflicts");
    });
  });

  describe("rate limit handling", () => {
    let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Mock setTimeout to resolve immediately for rate limit tests
      setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((cb: () => void) => {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      });
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it("retries on rate limit error and succeeds", async () => {
      // First two calls fail with rate limit, third succeeds
      ghMock
        .mockRejectedValueOnce(new Error("GraphQL rate limit exceeded"))
        .mockRejectedValueOnce(new Error("API rate limit"))
        .mockResolvedValueOnce({ stdout: JSON.stringify({ state: "open" }) });

      const scm = await create({});
      const result = await scm.getPRState(pr);

      expect(result).toBe("open");
      expect(ghMock).toHaveBeenCalledTimes(3);
    });

    it("throws after max retries exhausted and REST fallback fails", async () => {
      // All 3 GraphQL retries fail with rate limit
      ghMock
        .mockRejectedValueOnce(new Error("rate limit"))
        .mockRejectedValueOnce(new Error("rate limit"))
        .mockRejectedValueOnce(new Error("rate limit"))
        // 4th call: REST fallback also fails
        .mockRejectedValueOnce(new Error("rate limit"));

      const scm = await create({});

      await expect(scm.getPRState(pr)).rejects.toThrow();
      // 3 retries + 1 REST fallback attempt = 4 calls
      expect(ghMock).toHaveBeenCalledTimes(4);
    });

    it("does not retry non-rate-limit errors", async () => {
      // Non-rate-limit error should not retry
      ghMock.mockRejectedValueOnce(new Error("Not found"));

      const scm = await create({});

      await expect(scm.getPRState(pr)).rejects.toThrow("Not found");
      expect(ghMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("REST fallback URL construction", () => {
    it("throws for non-gh api commands", async () => {
      await expect(ghRestFallback(["pr", "view", "123"])).rejects.toThrow(
        "ghRestFallback only supports `gh api` commands",
      );
    });

    it("throws for GraphQL queries", async () => {
      await expect(ghRestFallback(["api", "graphql"])).rejects.toThrow(
        "ghRestFallback does not support GraphQL queries",
      );
    });

    it("throws for GraphQL with variables", async () => {
      await expect(ghRestFallback(["api", "graphql", "-f", "query=foo"])).rejects.toThrow(
        "ghRestFallback does not support GraphQL queries",
      );
    });

    it("constructs URL correctly for simple endpoint", async () => {
      // gh auth token call fails (no token), but curl call should still work
      ghMock
        .mockRejectedValueOnce(new Error("not authenticated"))
        .mockResolvedValueOnce({ stdout: '{"test": true}' });

      await ghRestFallback(["api", "repos/owner/repo/pulls"]);

      // Find the curl call in the mock calls
      const curlCalls = ghMock.mock.calls.filter((call) => call[0] === "curl");
      expect(curlCalls).toHaveLength(1);
      expect(curlCalls[0][1]).toContain("https://api.github.com/repos/owner/repo/pulls");
    });

    it("constructs URL correctly for endpoint with leading slash", async () => {
      ghMock
        .mockRejectedValueOnce(new Error("not authenticated"))
        .mockResolvedValueOnce({ stdout: '{"test": true}' });

      await ghRestFallback(["api", "/repos/owner/repo/pulls"]);

      const curlCalls = ghMock.mock.calls.filter((call) => call[0] === "curl");
      expect(curlCalls).toHaveLength(1);
      expect(curlCalls[0][1]).toContain("https://api.github.com/repos/owner/repo/pulls");
    });

    it("handles query string parameters", async () => {
      ghMock
        .mockRejectedValueOnce(new Error("not authenticated"))
        .mockResolvedValueOnce({ stdout: '{"test": true}' });

      await ghRestFallback(["api", "repos/owner/repo/pulls?per_page=100"]);

      const curlCalls = ghMock.mock.calls.filter((call) => call[0] === "curl");
      expect(curlCalls).toHaveLength(1);
      expect(curlCalls[0][1]).toContain("https://api.github.com/repos/owner/repo/pulls?per_page=100");
    });

    it("passes through --method GET flag", async () => {
      ghMock
        .mockRejectedValueOnce(new Error("not authenticated"))
        .mockResolvedValueOnce({ stdout: '{"test": true}' });

      await ghRestFallback(["api", "repos/owner/repo/pulls", "--method", "GET"]);

      const curlCalls = ghMock.mock.calls.filter((call) => call[0] === "curl");
      expect(curlCalls).toHaveLength(1);
      expect(curlCalls[0][1]).toContain("-X");
      expect(curlCalls[0][1]).toContain("GET");
    });

    it("finds endpoint when --method GET precedes the path", async () => {
      ghMock
        .mockRejectedValueOnce(new Error("not authenticated"))
        .mockResolvedValueOnce({ stdout: '{"test": true}' });

      await ghRestFallback([
        "api",
        "--method",
        "GET",
        "repos/owner/repo/pulls/1/comments?per_page=100",
      ]);

      const curlCalls = ghMock.mock.calls.filter((call) => call[0] === "curl");
      expect(curlCalls).toHaveLength(1);
      expect(curlCalls[0][1].join(" ")).toContain(
        "https://api.github.com/repos/owner/repo/pulls/1/comments?per_page=100",
      );
    });

    it("includes auth token when available", async () => {
      // First call is gh auth token, second is curl
      ghMock
        .mockResolvedValueOnce({ stdout: "test-token\n" })
        .mockResolvedValueOnce({ stdout: '{"test": true}' });

      await ghRestFallback(["api", "repos/owner/repo/pulls"]);

      const curlCalls = ghMock.mock.calls.filter((call) => call[0] === "curl");
      expect(curlCalls).toHaveLength(1);
      const curlArgs = curlCalls[0][1] as string[];
      // Token is written to a curl config file (not -H args) to keep it out of ps output
      expect(curlArgs).toContain("--config");
      const configIdx = curlArgs.indexOf("--config");
      const configPath = curlArgs[configIdx + 1];
      expect(configPath).toMatch(/[/\\].curl-auth-[\w-]+$/);
    });
  });

  // ---- GhCache write-dedupe exclusion ------------------------------------

  describe("GhCache write-operation dedupe exclusion", () => {
    it("concurrent identical write operations each invoke gh CLI independently (not deduplicated)", async () => {
      // Provide two separate responses. If in-flight dedupe incorrectly applied to writes,
      // ghMock would only be called once and the second response would go unconsumed.
      ghMock
        .mockResolvedValueOnce({ stdout: "" })
        .mockResolvedValueOnce({ stdout: "" });

      // Fire two concurrent identical merges for the same PR
      await Promise.all([scm.mergePR(pr, "squash"), scm.mergePR(pr, "squash")]);

      // Both calls must reach gh CLI — no in-flight sharing for write operations
      const mergeCalls = ghMock.mock.calls.filter(
        (c) => c[0] === "gh" && Array.isArray(c[1]) && (c[1] as string[]).includes("merge"),
      );
      expect(mergeCalls).toHaveLength(2);
    });
  });
});
