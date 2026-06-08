/**
 * Tests for postVerdict — covering the PATCH → CREATE fallback chain
 * when the existing verdict comment cannot be PATCHed.
 *
 * The two relevant fallbacks:
 *   1. 404 (Not Found) — the comment was deleted between findExistingVerdict
 *      and postVerdict. Fall back to CREATE a new comment.
 *   2. 403 (Forbidden) — the existing comment was posted by a different GitHub
 *      user (e.g. jleechan-af) and the current gh CLI is authenticated as
 *      jleechan2015. GitHub returns 403 because cross-user comment edits are
 *      not allowed. Fall back to CREATE a new comment — losing the idempotent
 *      re-use is preferable to silently dropping the new verdict.
 *
 * The pre-fix behavior rethrows the 403 error, causing the entire `ao skeptic verify`
 * run to fail with "Failed to post verdict" even though a fallback path exists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execMock = vi.hoisted(() => {
  const fn = vi.fn<(cmd: string, args: string[]) => Promise<{ stdout: string }>>();
  return fn;
});

vi.mock("../../lib/shell.js", () => ({
  exec: execMock,
}));

import { postVerdict } from "../../commands/skeptic/posting.js";

/**
 * Build a GitHub CLI error shape that mirrors what `gh api --method PATCH`
 * actually throws on a 403. execFileAsync rejects with an Error whose
 * .message contains both stderr ("gh: Forbidden (HTTP 403)") and stdout
 * ({"message":"...","status":"403"}). The same shape is used for 404.
 */
function makeGhApiError(status: number, message: string): Error {
  const stderr = `gh: ${message} (HTTP ${status})`;
  const stdout = `{"message":"${message}","documentation_url":"...","status":"${status}"}`;
  const err = new Error(
    `Command failed with exit code 1: gh api --method PATCH\n${stderr}\n${stdout}`,
  );
  return err;
}

describe("postVerdict — PATCH/CREATE fallback chain", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("PATCHes the existing comment on the happy path (same user)", async () => {
    let patchCalled = 0;
    let createCalled = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      const argStr = args.join(" ");
      if (argStr.includes("--method") && argStr.includes("PATCH") && argStr.includes("/comments/12345")) {
        patchCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (argStr.includes("/issues/654/comments") && !argStr.includes("--method")) {
        createCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const body = await postVerdict(
      "owner",
      "repo",
      654,
      "VERDICT: FAIL",
      12345, // existing comment ID
      "github-actions[bot]",
      "abc1234",
      "Full LLM output\n\nVERDICT: FAIL",
    );

    expect(patchCalled).toBe(1);
    expect(createCalled).toBe(0);
    expect(body).toContain("VERDICT: FAIL");
    expect(body).toContain("<!-- skeptic-agent-verdict -->");
  });

  it("falls back to CREATE when PATCH returns 404 (comment deleted)", async () => {
    let patchCalled = 0;
    let createCalled = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      const argStr = args.join(" ");
      if (argStr.includes("--method") && argStr.includes("PATCH")) {
        patchCalled += 1;
        throw makeGhApiError(404, "Not Found");
      }
      if (argStr.includes("/issues/654/comments") && !argStr.includes("--method")) {
        createCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const body = await postVerdict(
      "owner",
      "repo",
      654,
      "VERDICT: FAIL",
      99999, // deleted comment
      "github-actions[bot]",
      "abc1234",
      "Full LLM output\n\nVERDICT: FAIL",
    );

    expect(patchCalled).toBe(1);
    expect(createCalled).toBe(1);
    expect(body).toContain("VERDICT: FAIL");
  });

  it("falls back to CREATE when PATCH returns 403 (cross-user edit blocked)", async () => {
    let patchCalled = 0;
    let createCalled = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      const argStr = args.join(" ");
      if (argStr.includes("--method") && argStr.includes("PATCH")) {
        patchCalled += 1;
        throw makeGhApiError(403, "Forbidden: you cannot edit comments that you did not write");
      }
      if (argStr.includes("/issues/654/comments") && !argStr.includes("--method")) {
        createCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const body = await postVerdict(
      "owner",
      "repo",
      654,
      "VERDICT: FAIL",
      12345, // comment posted by a different user
      "github-actions[bot]",
      "abc1234",
      "Full LLM output\n\nVERDICT: FAIL",
    );

    // This is the regression we are fixing — the pre-fix code rethrew 403
    // and the post step printed "Failed to post verdict" without creating
    // a new comment. After the fix, we expect both patchCalled==1 and
    // createCalled==1, and the post step returns the new comment body.
    expect(patchCalled).toBe(1);
    expect(createCalled).toBe(1);
    expect(body).toContain("VERDICT: FAIL");
  });

  it("rethrows non-recoverable 403 errors (e.g. rate limit, auth) without falling back", async () => {
    let patchCalled = 0;
    let createCalled = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      const argStr = args.join(" ");
      if (argStr.includes("--method") && argStr.includes("PATCH")) {
        patchCalled += 1;
        throw makeGhApiError(403, "Resource not accessible by integration (rate limit / permission)");
      }
      if (argStr.includes("/issues/654/comments") && !argStr.includes("--method")) {
        createCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      postVerdict(
        "owner",
        "repo",
        654,
        "VERDICT: FAIL",
        12345,
        "github-actions[bot]",
        "abc1234",
        "Full LLM output\n\nVERDICT: FAIL",
      ),
    ).rejects.toThrow(/Resource not accessible/i);

    expect(patchCalled).toBe(1);
    expect(createCalled).toBe(0);
  });

  it("rethrows non-404/403 errors (e.g. 422 oversized body) without falling back", async () => {
    let patchCalled = 0;
    let createCalled = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      const argStr = args.join(" ");
      if (argStr.includes("--method") && argStr.includes("PATCH")) {
        patchCalled += 1;
        throw makeGhApiError(422, "Unprocessable Entity");
      }
      if (argStr.includes("/issues/654/comments") && !argStr.includes("--method")) {
        createCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      postVerdict(
        "owner",
        "repo",
        654,
        "VERDICT: FAIL",
        12345,
        "github-actions[bot]",
        "abc1234",
        "Full LLM output\n\nVERDICT: FAIL",
      ),
    ).rejects.toThrow(/Unprocessable/i);

    expect(patchCalled).toBe(1);
    expect(createCalled).toBe(0);
  });

  it("creates a fresh comment when no existing comment ID is provided", async () => {
    let patchCalled = 0;
    let createCalled = 0;
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      const argStr = args.join(" ");
      if (argStr.includes("--method") && argStr.includes("PATCH")) {
        patchCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (argStr.includes("/issues/654/comments") && !argStr.includes("--method")) {
        createCalled += 1;
        return { stdout: "{}", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const body = await postVerdict(
      "owner",
      "repo",
      654,
      "VERDICT: FAIL",
      null,
      "github-actions[bot]",
      "abc1234",
      "Full LLM output\n\nVERDICT: FAIL",
    );

    expect(patchCalled).toBe(0);
    expect(createCalled).toBe(1);
    expect(body).toContain("VERDICT: FAIL");
  });
});
