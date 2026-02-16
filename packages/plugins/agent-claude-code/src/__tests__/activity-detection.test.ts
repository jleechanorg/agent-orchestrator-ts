import { describe, it, expect } from "vitest";
import { toClaudeProjectPath } from "../index.js";

describe("Claude Code Activity Detection", () => {
  describe("toClaudeProjectPath", () => {
    it("encodes paths correctly", () => {
      expect(toClaudeProjectPath("/Users/dev/.worktrees/ao")).toBe(
        "Users-dev--worktrees-ao",
      );
    });

    it("strips leading slash", () => {
      expect(toClaudeProjectPath("/tmp/test")).toBe("tmp-test");
    });

    it("replaces dots", () => {
      expect(toClaudeProjectPath("/path/to/.hidden")).toBe("path-to--hidden");
    });

    it("handles Windows paths", () => {
      expect(toClaudeProjectPath("C:\\Users\\dev\\project")).toBe(
        "C-Users-dev-project",
      );
    });
  });

  // NOTE: Full integration tests for getActivityState() require mocking homedir()
  // or using a real Claude Code installation with actual session files.
  // For now, we test the path encoding logic which is the core transformation.
  // End-to-end testing should be done manually or with a real Claude Code instance.
});
