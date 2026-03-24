import { describe, it, expect } from "vitest";
import { parseCliArgs, parseSlackMessage } from "../entrypoints.js";

describe("parseCliArgs", () => {
  it("parses a simple task", () => {
    const result = parseCliArgs(["write design for auth"]);
    expect(result).toEqual({ task: "write design for auth" });
  });

  it("parses task with --repo flag", () => {
    const result = parseCliArgs(["--repo", "ao", "add a README"]);
    expect(result).toEqual({ task: "add a README", repo: "ao" });
  });

  it("parses task with --model flag", () => {
    const result = parseCliArgs([
      "--model",
      "Claude Opus 4.6",
      "implement feature",
    ]);
    expect(result).toEqual({
      task: "implement feature",
      model: "Claude Opus 4.6",
    });
  });

  it("parses task with --mode flag", () => {
    const result = parseCliArgs(["--mode", "Fast", "quick fix"]);
    expect(result).toEqual({ task: "quick fix", mode: "Fast" });
  });

  it("ignores unknown --flags", () => {
    const result = parseCliArgs(["--unknown", "val", "do something"]);
    expect(result.task).toBe("do something");
  });

  it("throws when task is empty", () => {
    expect(() => parseCliArgs([])).toThrow("Task is required");
    expect(() => parseCliArgs(["--repo", "ao"])).toThrow("Task is required");
  });

  it("joins multiple positional args into task", () => {
    const result = parseCliArgs(["add", "a", "README"]);
    expect(result.task).toBe("add a README");
  });

  it("parses all flags together", () => {
    const result = parseCliArgs([
      "--repo",
      "ao",
      "--model",
      "Gemini",
      "--mode",
      "Planning",
      "write tests",
    ]);
    expect(result).toEqual({
      task: "write tests",
      repo: "ao",
      model: "Gemini",
      mode: "Planning",
    });
  });
});

describe("parseSlackMessage", () => {
  it("parses simple antigravity command", () => {
    const result = parseSlackMessage("antigravity: write a README");
    expect(result).toEqual({ task: "write a README" });
  });

  it("parses command with repo", () => {
    const result = parseSlackMessage(
      "antigravity: add logging in repo: worldarchitect",
    );
    expect(result).toEqual({
      task: "add logging",
      repo: "worldarchitect",
    });
  });

  it("is case insensitive for prefix", () => {
    const result = parseSlackMessage("Antigravity: do something");
    expect(result).toEqual({ task: "do something" });
  });

  it("returns null for non-matching messages", () => {
    expect(parseSlackMessage("hello world")).toBeNull();
    expect(parseSlackMessage("please antigravity")).toBeNull();
    expect(parseSlackMessage("")).toBeNull();
  });

  it("returns null when task is empty", () => {
    expect(parseSlackMessage("antigravity:")).toBeNull();
    expect(parseSlackMessage("antigravity:   ")).toBeNull();
  });

  it("trims whitespace in task and repo", () => {
    const result = parseSlackMessage(
      "antigravity:   fix bug   in repo:   ao  ",
    );
    expect(result).toEqual({ task: "fix bug", repo: "ao" });
  });
});
