/**
 * Metadata hydration tests for session-reaper (bd-s4t).
 *
 * Covers sessionFromMetadata prState round-trip and VALID_PR_STATES set
 * correctness. Separated from session-reaper.test.ts to keep files under
 * the ~300 LOC guideline.
 */
import { describe, it, expect } from "vitest";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import { writeMetadata, readMetadata } from "../metadata.js";
import { VALID_PR_STATES, type PRState } from "../types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

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

  it("real metadata I/O round-trip: writeMetadata → readMetadata → sessionFromMetadata", () => {
    // Use a real temp directory to exercise the actual file I/O path
    const dataDir = join(tmpdir(), `ao-metadata-roundtrip-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    try {
      const metadata = {
        worktree: "/tmp/wt-roundtrip",
        branch: "feat/roundtrip",
        status: "working" as const,
        pr: "https://github.com/org/repo/pull/77",
        prState: "merged" as const,
      };

      // Write via the public API (serializes to key=value, atomic write)
      writeMetadata(dataDir, "session-roundtrip", metadata);

      // Read back via the public API (parses key=value, validates prState)
      const parsed = readMetadata(dataDir, "session-roundtrip");
      expect(parsed).not.toBeNull();
      expect(parsed!.prState).toBe("merged");

      // Hydrate session from the parsed metadata
      const session = sessionFromMetadata("session-roundtrip", parsed!);
      expect(session.pr).not.toBeNull();
      expect(session.pr!.state).toBe("merged");
    } finally {
      rmSync(dataDir, { recursive: true });
    }
  });
});
