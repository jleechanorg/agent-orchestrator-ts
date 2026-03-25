/**
 * Metadata hydration tests for session-reaper (bd-s4t).
 *
 * Covers sessionFromMetadata prState round-trip and VALID_PR_STATES set
 * correctness. Separated from session-reaper.test.ts to keep files under
 * the ~300 LOC guideline.
 */
import { describe, it, expect } from "vitest";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import { VALID_PR_STATES, type PRState } from "../types.js";

describe("sessionFromMetadata: prState round-trip", () => {
  it("hydrates session.pr.state from metadata prState=open", () => {
    const session = sessionFromMetadata("test-1", {
      project: "test-project",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/test-1",
      pr: "https://github.com/org/repo/pull/42",
      prState: "open",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBe("open");
    expect(session.metadata["prState"]).toBe("open");
  });

  it("hydrates session.pr.state from metadata prState=merged", () => {
    const session = sessionFromMetadata("test-2", {
      project: "test-project",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/test-2",
      pr: "https://github.com/org/repo/pull/99",
      prState: "merged",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBe("merged");
    expect(session.metadata["prState"]).toBe("merged");
  });

  it("hydrates session.pr.state from metadata prState=closed", () => {
    const session = sessionFromMetadata("test-3", {
      project: "test-project",
      branch: "feat/test",
      status: "working",
      worktree: "/tmp/test-3",
      pr: "https://github.com/org/repo/pull/17",
      prState: "closed",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBe("closed");
  });

  it("rejects invalid prState values (session.pr.state remains undefined)", () => {
    const session = sessionFromMetadata("test-4", {
      project: "test-project",
      status: "working",
      pr: "https://github.com/org/repo/pull/1",
      prState: "invalid-state",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBeUndefined();
    expect(session.metadata["prState"]).toBe("invalid-state");
  });

  it("VALID_PR_STATES correctly identifies valid and invalid values", () => {
    const valid: PRState[] = ["open", "merged", "closed"];
    const invalid = ["pending", "draft", "APPROVED", "CHANGES_REQUESTED", ""];
    for (const v of valid) {
      expect(VALID_PR_STATES.has(v)).toBe(true);
    }
    for (const v of invalid) {
      expect(VALID_PR_STATES.has(v as PRState)).toBe(false);
    }
  });

  it("no prState in metadata → session.pr.state is undefined", () => {
    const session = sessionFromMetadata("test-5", {
      project: "test-project",
      status: "working",
      worktree: "/tmp/test-5",
      pr: "https://github.com/org/repo/pull/5",
    });
    expect(session.pr).not.toBeNull();
    expect(session.pr!.state).toBeUndefined();
  });
});
