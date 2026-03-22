import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "../src/index.js";
import type { ProjectConfig } from "@jleechanorg/ao-core";

function makeProject(path: string): ProjectConfig {
  return {
    repo: "test/repo",
    defaultBranch: "main",
    path,
  } as ProjectConfig;
}

function writeBeads(dir: string, beads: Array<Record<string, unknown>>): void {
  const beadsDir = join(dir, ".beads");
  mkdirSync(beadsDir, { recursive: true });
  const content = beads.map((b) => JSON.stringify(b)).join("\n") + "\n";
  writeFileSync(join(beadsDir, "issues.jsonl"), content);
}

describe("tracker-beads", () => {
  let tmpDir: string;
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tracker-beads-test-"));
    mkdirSync(tmpDir, { recursive: true });
    tracker = create();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleBeads = [
    {
      id: "bd-abc",
      title: "Fix the widget",
      description: "The widget is broken. Fix it by updating the handler.",
      status: "open",
      priority: 1,
      issue_type: "bug",
    },
    {
      id: "bd-xyz",
      title: "Add caching layer",
      description: "Add TTL cache to reduce API calls.",
      status: "closed",
      priority: 2,
      issue_type: "task",
      dependencies: [{ depends_on_id: "bd-epic", type: "blocks" }],
    },
    {
      id: "bd-epic",
      title: "Performance improvements",
      description: "Epic for all perf work.",
      status: "open",
      priority: 1,
      issue_type: "epic",
    },
  ];

  it("getIssue resolves a bead by ID", async () => {
    writeBeads(tmpDir, sampleBeads);
    const issue = await tracker.getIssue("bd-abc", makeProject(tmpDir));
    expect(issue.id).toBe("bd-abc");
    expect(issue.title).toBe("Fix the widget");
    expect(issue.state).toBe("open");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("getIssue throws for unknown bead", async () => {
    writeBeads(tmpDir, sampleBeads);
    await expect(tracker.getIssue("bd-nope", makeProject(tmpDir))).rejects.toThrow("not found");
  });

  it("isCompleted returns true for closed beads", async () => {
    writeBeads(tmpDir, sampleBeads);
    expect(await tracker.isCompleted("bd-xyz", makeProject(tmpDir))).toBe(true);
    expect(await tracker.isCompleted("bd-abc", makeProject(tmpDir))).toBe(false);
  });

  it("branchName generates feat/ prefix", () => {
    expect(tracker.branchName("bd-abc", makeProject(tmpDir))).toBe("feat/bd-abc");
  });

  it("generatePrompt includes title, description, and metadata", async () => {
    writeBeads(tmpDir, sampleBeads);
    const prompt = await tracker.generatePrompt("bd-abc", makeProject(tmpDir));
    expect(prompt).toContain("bd-abc");
    expect(prompt).toContain("Fix the widget");
    expect(prompt).toContain("The widget is broken");
    expect(prompt).toContain("P1");
    expect(prompt).toContain("bug");
  });

  it("generatePrompt includes parent epic context", async () => {
    writeBeads(tmpDir, sampleBeads);
    const prompt = await tracker.generatePrompt("bd-xyz", makeProject(tmpDir));
    expect(prompt).toContain("bd-xyz");
    expect(prompt).toContain("Add caching layer");
    expect(prompt).toContain("Parent Epic: bd-epic");
    expect(prompt).toContain("Performance improvements");
  });

  it("generatePrompt handles missing bead gracefully", async () => {
    writeBeads(tmpDir, sampleBeads);
    const prompt = await tracker.generatePrompt("bd-nope", makeProject(tmpDir));
    expect(prompt).toContain("bd-nope");
    expect(prompt).toContain("Could not find");
  });

  it("listIssues filters by state", async () => {
    const beadsWithCancelled = [
      ...sampleBeads,
      {
        id: "bd-cancelled",
        title: "Cancelled task",
        status: "wontfix",
        priority: 3,
        issue_type: "task",
      },
    ];
    writeBeads(tmpDir, beadsWithCancelled);
    const open = await tracker.listIssues!({ state: "open" }, makeProject(tmpDir));
    expect(open.length).toBe(2); // bd-abc and bd-epic
    const closed = await tracker.listIssues!({ state: "closed" }, makeProject(tmpDir));
    // closed state includes both "closed" (bd-xyz) and "cancelled" (bd-cancelled) terminal states
    expect(closed.length).toBe(2);
    const closedIds = closed.map((i) => i.id);
    expect(closedIds).toContain("bd-xyz");
    expect(closedIds).toContain("bd-cancelled");
  });

  it("handles missing .beads directory", async () => {
    // No writeBeads call — directory doesn't exist
    await expect(tracker.getIssue("bd-abc", makeProject(tmpDir))).rejects.toThrow("not found");
    const prompt = await tracker.generatePrompt("bd-abc", makeProject(tmpDir));
    expect(prompt).toContain("Could not find");
  });

  it("filters out tombstone records", async () => {
    const beadsWithTombstone = [
      ...sampleBeads,
      {
        id: "bd-dead",
        title: "Deleted bead",
        description: "This was removed.",
        status: "tombstone",
        priority: 3,
        issue_type: "task",
      },
    ];
    writeBeads(tmpDir, beadsWithTombstone);
    // Tombstone should not appear in listings
    const all = await tracker.listIssues!({}, makeProject(tmpDir));
    expect(all.find((i) => i.id === "bd-dead")).toBeUndefined();
    // Tombstone should not be resolvable
    await expect(tracker.getIssue("bd-dead", makeProject(tmpDir))).rejects.toThrow("not found");
  });

  it("handles beads with no description", async () => {
    const beadsNoDesc = [
      { id: "bd-bare", title: "Bare bead", status: "open", priority: 2 },
    ];
    writeBeads(tmpDir, beadsNoDesc);
    const issue = await tracker.getIssue("bd-bare", makeProject(tmpDir));
    expect(issue.description).toBe("");
    const prompt = await tracker.generatePrompt("bd-bare", makeProject(tmpDir));
    expect(prompt).toContain("bd-bare");
    expect(prompt).toContain("Bare bead");
    expect(prompt).toContain("(no description)");
  });
});
