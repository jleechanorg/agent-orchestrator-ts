import { describe, it, expect } from "vitest";
import { messageContainsCommentFixIntent, transformToSlashCommand } from "../utils.js";

describe("messageContainsCommentFixIntent", () => {
  it("returns true for 'fix comments' message", () => {
    expect(messageContainsCommentFixIntent("There are review comments on your PR")).toBe(true);
  });

  it("returns true for 'review comments' message", () => {
    expect(messageContainsCommentFixIntent("Please review the comments on this PR")).toBe(true);
  });

  it("returns true for 'address feedback' message", () => {
    expect(messageContainsCommentFixIntent("Please address the feedback provided")).toBe(true);
  });

  it("returns true for 'changes requested' message", () => {
    expect(messageContainsCommentFixIntent("CR has posted changes requested")).toBe(true);
  });

  it("returns true for 'CI failing' message", () => {
    expect(messageContainsCommentFixIntent("CI failing on your PR")).toBe(true);
  });

  it("returns true for 'not mergeable' message", () => {
    expect(messageContainsCommentFixIntent("PR is not mergeable")).toBe(true);
  });

  it("returns true for 'drive to green' message", () => {
    expect(messageContainsCommentFixIntent("Drive this PR to green")).toBe(true);
  });

  it("returns true for skeptic structured advice", () => {
    expect(messageContainsCommentFixIntent("Skeptic has advice for your PR")).toBe(true);
  });

  it("returns true for merge conflict message", () => {
    expect(messageContainsCommentFixIntent("PR has merge conflicts")).toBe(true);
  });

  it("returns false for plain informational message", () => {
    expect(messageContainsCommentFixIntent("Your PR was merged successfully")).toBe(false);
  });

  it("returns false for general task assignment", () => {
    expect(messageContainsCommentFixIntent("Please work on the login feature")).toBe(false);
  });
});

describe("transformToSlashCommand", () => {
  it("transforms 'fix comments' message to /copilot", () => {
    const result = transformToSlashCommand("There are review comments on your PR. Check gh pr view.");
    expect(result).toMatch(/^\/copilot/);
    expect(result).toContain("review comments");
  });

  it("transforms 'CI failing' message to /polish", () => {
    const result = transformToSlashCommand("CI failing on your PR — tests are broken.");
    expect(result).toMatch(/^\/polish/);
    expect(result).toContain("CI");
  });

  it("transforms 'not mergeable' message to /polish", () => {
    const result = transformToSlashCommand("PR is not mergeable — fix the merge conflict.");
    expect(result).toMatch(/^\/polish/);
  });

  it("transforms skeptic advice to /polish", () => {
    const result = transformToSlashCommand("Skeptic has flagged aVERDICT issue on your PR.");
    expect(result).toMatch(/^\/polish/);
  });

  it("transforms 'drive to green' to /polish", () => {
    const result = transformToSlashCommand("Drive this PR to 6-green.");
    expect(result).toMatch(/^\/polish/);
  });

  it("slash command is first line, message is second", () => {
    const result = transformToSlashCommand("There are review comments on your PR.");
    const lines = result.split("\n");
    expect(lines[0]).toBe("/copilot");
    expect(lines[1]).toContain("review comments");
  });

  it("does not double-prefix if message already starts with slash command", () => {
    const result = transformToSlashCommand("/copilot Some previous context");
    const firstLine = result.split("\n")[0];
    expect(firstLine).toBe("/copilot");
    expect(result).not.toMatch(/^\/copilot\/copilot/);
  });

  it("does not double-prefix if message starts with /polish", () => {
    const result = transformToSlashCommand("/polish Some previous context");
    const firstLine = result.split("\n")[0];
    expect(firstLine).toBe("/polish");
    expect(result).not.toMatch(/^\/polish\/polish/);
  });
});
