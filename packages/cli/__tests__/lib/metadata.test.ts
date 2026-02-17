import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readMetadata,
  writeMetadata,
  archiveMetadata,
  listSessionFiles,
  findSessionForIssue,
} from "../../src/lib/metadata.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readMetadata", () => {
  it("returns null for non-existent file", () => {
    expect(readMetadata(join(tmpDir, "nonexistent"))).toBeNull();
  });

  it("parses key=value format", () => {
    const file = join(tmpDir, "session-1");
    writeFileSync(
      file,
      "worktree=/home/user/.worktrees/app/session-1\nbranch=feat/INT-123\nstatus=working\nissue=INT-123\n",
    );
    const meta = readMetadata(file);
    expect(meta).not.toBeNull();
    expect(meta!.worktree).toBe("/home/user/.worktrees/app/session-1");
    expect(meta!.branch).toBe("feat/INT-123");
    expect(meta!.status).toBe("working");
    expect(meta!.issue).toBe("INT-123");
  });

  it("handles values containing equals signs", () => {
    const file = join(tmpDir, "session-2");
    writeFileSync(file, "summary=key=value pair in desc\n");
    const meta = readMetadata(file);
    expect(meta).not.toBeNull();
    expect(meta!.summary).toBe("key=value pair in desc");
  });

  it("ignores empty lines", () => {
    const file = join(tmpDir, "session-3");
    writeFileSync(file, "branch=main\n\nstatus=idle\n\n");
    const meta = readMetadata(file);
    expect(meta!.branch).toBe("main");
    expect(meta!.status).toBe("idle");
  });

  it("handles PR URLs with embedded numbers", () => {
    const file = join(tmpDir, "session-4");
    writeFileSync(file, "pr=https://github.com/org/repo/pull/42\nbranch=feat/fix\n");
    const meta = readMetadata(file);
    expect(meta!.pr).toBe("https://github.com/org/repo/pull/42");
  });
});

describe("writeMetadata", () => {
  it("creates metadata file with key=value pairs", () => {
    const file = join(tmpDir, "subdir", "session-1");
    writeMetadata(file, {
      worktree: "/path/to/worktree",
      branch: "feat/test",
      status: "starting",
    });
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("worktree=/path/to/worktree\n");
    expect(content).toContain("branch=feat/test\n");
    expect(content).toContain("status=starting\n");
  });

  it("skips undefined and null values", () => {
    const file = join(tmpDir, "session-2");
    writeMetadata(file, {
      branch: "main",
      status: "working",
      pr: undefined,
      issue: undefined,
    });
    const content = readFileSync(file, "utf-8");
    expect(content).not.toContain("pr=");
    expect(content).not.toContain("issue=");
    expect(content).toContain("branch=main");
  });

  it("creates parent directories if needed", () => {
    const file = join(tmpDir, "deep", "nested", "dir", "session-1");
    writeMetadata(file, { branch: "main", status: "idle" });
    expect(existsSync(file)).toBe(true);
  });
});

describe("archiveMetadata", () => {
  it("moves metadata to archive dir with timestamp", () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "app-1"), "branch=main\n");

    archiveMetadata(sessionDir, "app-1");

    expect(existsSync(join(sessionDir, "app-1"))).toBe(false);
    const archiveDir = join(sessionDir, "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archived = readdirSync(archiveDir);
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^app-1_\d{4}-\d{2}-\d{2}T/);
  });

  it("does nothing for non-existent metadata", () => {
    archiveMetadata(join(tmpDir, "sessions"), "nonexistent");
    // Should not throw
  });
});

describe("listSessionFiles", () => {
  it("returns empty array for non-existent directory", async () => {
    const result = await listSessionFiles(join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("returns session files, excluding dotfiles and archive", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    mkdirSync(join(sessionDir, "archive"));
    writeFileSync(join(sessionDir, "app-1"), "");
    writeFileSync(join(sessionDir, "app-2"), "");
    writeFileSync(join(sessionDir, ".hidden"), "");

    const result = await listSessionFiles(sessionDir);
    expect(result.sort()).toEqual(["app-1", "app-2"]);
  });
});

describe("findSessionForIssue", () => {
  it("finds session by issue ID match", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "app-1"), "branch=feat/INT-100\nissue=INT-100\n");
    writeFileSync(join(sessionDir, "app-2"), "branch=feat/INT-200\nissue=INT-200\n");

    const result = await findSessionForIssue(sessionDir, "INT-200", ["app-1", "app-2"]);
    expect(result).toBe("app-2");
  });

  it("returns null when no match found", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "app-1"), "branch=main\nissue=INT-100\n");

    const result = await findSessionForIssue(sessionDir, "INT-999", ["app-1"]);
    expect(result).toBeNull();
  });

  it("is case-insensitive", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "app-1"), "issue=int-100\n");

    const result = await findSessionForIssue(sessionDir, "INT-100", ["app-1"]);
    expect(result).toBe("app-1");
  });

  it("only matches sessions that are in the tmux list", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, "app-1"), "issue=INT-100\n");
    writeFileSync(join(sessionDir, "app-2"), "issue=INT-200\n");

    // app-2 is NOT in tmux sessions list
    const result = await findSessionForIssue(sessionDir, "INT-200", ["app-1"]);
    expect(result).toBeNull();
  });

  it("filters by project when projectId is specified", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    // Project A has INT-100
    writeFileSync(join(sessionDir, "app-1"), "issue=INT-100\nproject=project-a\n");
    // Project B also has INT-100 (different session)
    writeFileSync(join(sessionDir, "backend-1"), "issue=INT-100\nproject=project-b\n");

    // Should only find project-a's session
    const resultA = await findSessionForIssue(
      sessionDir,
      "INT-100",
      ["app-1", "backend-1"],
      "project-a",
    );
    expect(resultA).toBe("app-1");

    // Should only find project-b's session
    const resultB = await findSessionForIssue(
      sessionDir,
      "INT-100",
      ["app-1", "backend-1"],
      "project-b",
    );
    expect(resultB).toBe("backend-1");

    // Without projectId filter, should find first match
    const resultAny = await findSessionForIssue(sessionDir, "INT-100", ["app-1", "backend-1"]);
    expect(resultAny).toBe("app-1");
  });

  it("excludes sessions without project field when projectId filter is specified", async () => {
    const sessionDir = join(tmpDir, "sessions");
    mkdirSync(sessionDir);
    // Legacy session without project field
    writeFileSync(join(sessionDir, "legacy-1"), "issue=INT-100\n");
    // Current session with project field
    writeFileSync(join(sessionDir, "app-1"), "issue=INT-100\nproject=project-a\n");

    // Should NOT find legacy session when filtering by project
    const result = await findSessionForIssue(
      sessionDir,
      "INT-100",
      ["legacy-1", "app-1"],
      "project-a",
    );
    expect(result).toBe("app-1");

    // Without projectId filter, should find one of the sessions (order not guaranteed)
    const resultAny = await findSessionForIssue(sessionDir, "INT-100", ["legacy-1", "app-1"]);
    expect(["legacy-1", "app-1"]).toContain(resultAny);
  });
});
