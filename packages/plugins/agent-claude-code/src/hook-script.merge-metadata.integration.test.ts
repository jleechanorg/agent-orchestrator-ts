import { describe, it, expect } from "vitest";
import { setupHookScriptIntegrationTest } from "./hook-script.integration-test-helpers.js";

const { runHook, parseHookOutput, getNoPythonBinDir } = setupHookScriptIntegrationTest();

describe("hook script: gh pr merge", () => {
  it("blocks plain gh pr merge via PreToolUse policy output", () => {
    const { stdout, metadata } = runHook({
      command: "gh pr merge 123 --squash",
      metadataContent: "status=pr_open\n",
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("gh pr merge");
    expect(metadata).toContain("status=pr_open");
    expect(metadata).not.toContain("status=merged");
  });

  it("detects plain gh pr merge", () => {
    const { metadata } = runHook({
      command: "gh pr merge 123 --squash",
      allowMerge: true,
      hookEvent: "PostToolUse",
    });
    expect(metadata).toContain("status=merged");
  });

  it("PreToolUse: allows gh pr merge when AO_ALLOW_GH_PR_MERGE=1", () => {
    const { stdout, metadata } = runHook({
      command: "gh pr merge 123 --squash",
      allowMerge: true,
      hookEvent: "PreToolUse",
      metadataContent: "status=pr_open\n",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBeUndefined();
    expect(metadata).toContain("status=pr_open");
    expect(metadata).not.toContain("status=merged");
  });

  it("PostToolUse: allows gh pr merge with AO_ALLOW_GH_PR_MERGE=1 and updates metadata", () => {
    const { stdout, metadata } = runHook({
      command: "gh pr merge 123 --squash",
      allowMerge: true,
      hookEvent: "PostToolUse",
      metadataContent: "status=pr_open\n",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBeUndefined();
    expect(metadata).toContain("status=merged");
  });

  it("detects gh pr merge with cd && prefix when explicitly allowed", () => {
    const { metadata } = runHook({
      command: "cd ~/.worktrees/project && gh pr merge 42 --squash",
      allowMerge: true,
      hookEvent: "PostToolUse",
    });
    expect(metadata).toContain("status=merged");
  });

  it("detects gh pr merge with cd ; prefix when explicitly allowed", () => {
    const { metadata } = runHook({
      command: "cd /project ; gh pr merge --rebase",
      allowMerge: true,
      hookEvent: "PostToolUse",
    });
    expect(metadata).toContain("status=merged");
  });

  it("detects gh pr merge with cd && prefix when python3 is unavailable", () => {
    const { metadata } = runHook({
      command: "cd ~/.worktrees/project && gh pr merge 42 --squash",
      allowMerge: true,
      hookEvent: "PostToolUse",
      path: getNoPythonBinDir(),
    });
    expect(metadata).toContain("status=merged");
  });
});

describe("hook script: non-matching commands", () => {
  it("ignores plain ls command", () => {
    const { metadata } = runHook({
      command: "ls -la",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores non-Bash tool calls", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "test"',
      toolName: "Read",
      output: "https://github.com/owner/repo/pull/1",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores commands with non-zero exit code", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "test"',
      exitCode: 1,
      output: "https://github.com/owner/repo/pull/1",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores cd-only commands (no chained git/gh)", () => {
    const { metadata } = runHook({
      command: "cd /some/directory",
    });
    expect(metadata).toBe("status=spawning\n");
  });

  it("ignores git status", () => {
    const { metadata } = runHook({
      command: "cd /project && git status",
    });
    expect(metadata).toBe("status=spawning\n");
  });
});

describe("hook script: metadata file updates", () => {
  it("updates an existing key in the metadata file", () => {
    const { metadata } = runHook({
      command: "gh pr merge 10 --squash",
      metadataContent: "status=pr_open\nbranch=feat/test\n",
      allowMerge: true,
      hookEvent: "PostToolUse",
    });
    expect(metadata).toContain("status=merged");
    expect(metadata).toContain("branch=feat/test");
    expect(metadata).not.toContain("status=pr_open");
  });

  it("appends a new key to the metadata file", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "test"',
      output: "https://github.com/owner/repo/pull/99",
      metadataContent: "branch=feat/test\n",
    });
    expect(metadata).toContain("branch=feat/test");
    expect(metadata).toContain("pr=https://github.com/owner/repo/pull/99");
    expect(metadata).toContain("status=pr_open");
  });

  it("returns systemMessage JSON on successful detection", () => {
    const { stdout } = runHook({
      command: "gh pr merge 1 --squash",
      allowMerge: true,
      hookEvent: "PostToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.systemMessage).toContain("merged");
  });

  it("returns empty JSON for non-matching commands", () => {
    const { stdout } = runHook({
      command: "echo hello",
    });
    expect(stdout.trim()).toBe("{}");
  });
});
