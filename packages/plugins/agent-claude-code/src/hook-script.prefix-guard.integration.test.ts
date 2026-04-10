import { describe, it, expect } from "vitest";
import { setupHookScriptIntegrationTest } from "./hook-script.integration-test-helpers.js";

const { runHook, parseHookOutput, getNoPythonBinDir } = setupHookScriptIntegrationTest();

describe("hook script: [agento] prefix enforcement", () => {
  it("rewrites gh pr create with title missing [agento] prefix in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain("gh pr create --title");
    expect(output.updatedInput?.command).toContain("[agento] fix: bug");
  });

  it("allows gh pr create with [agento] prefix in PreToolUse (exits silently)", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "[agento] fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("allows gh pr create with [agento] prefix (single-quoted) in PreToolUse", () => {
    const { stdout } = runHook({
      command: "gh pr create --title '[agento] fix: bug' --body 'test'",
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("allows gh pr create with [agento] prefix (double-quoted) in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "[agento] fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("allows gh pr create with [agento] prefix (equals form: --title=[agento]) in PreToolUse", () => {
    const { stdout } = runHook({
      command: "gh pr create --title='[agento] fix' --body 'test'",
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("rewrites gh pr create with env prefix but missing [agento] in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'GH_TOKEN=ghs_xxxx gh pr create --title "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain("GH_TOKEN=ghs_xxxx");
    expect(output.updatedInput?.command).toContain("[agento] fix: bug");
  });

  it("rewrites gh pr create with cd and env prefixes before the guarded command", () => {
    const { stdout } = runHook({
      command: 'cd ~/.worktrees/project && GH_TOKEN=ghs_xxxx gh pr create --title "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain("cd ~/.worktrees/project && GH_TOKEN=ghs_xxxx gh pr create --title");
    expect(output.updatedInput?.command).toContain("[agento] fix: bug");
  });

  it("allows gh pr create with env prefix and [agento] title in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'GH_TOKEN=ghs_xxxx gh pr create --title "[agento] fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("rewrites gh pr create with env value containing equals and missing [agento] prefix", () => {
    const { stdout } = runHook({
      command: 'TOKEN=a=b gh pr create --title "fix: bug"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain("TOKEN=a=b");
    expect(output.updatedInput?.command).toContain("[agento] fix: bug");
  });

  it("allows gh pr create with env value containing equals and [agento] prefix in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'TOKEN=a=b gh pr create --title "[agento] fix: bug"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("allows gh pr create with quoted env values and [agento] prefix in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'FOO="a b" BAR=\'c d\' gh pr create --title "[agento] fix: bug"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("denies gh pr create without an explicit title flag", () => {
    const { stdout } = runHook({
      command: "gh pr create --fill",
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("must include --title");
  });

  it("denies chained commands before gh pr create in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'cd /tmp && echo unsafe && gh pr create --title "fix"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("cannot safely analyze chained shell commands");
  });

  it("PostToolUse: detects gh pr create with env prefix containing embedded equals", () => {
    const { metadata } = runHook({
      command: 'FOO=a=b gh pr create --title "[agento] fix"',
      output: "https://github.com/owner/repo/pull/88",
    });
    expect(metadata).toContain("pr=https://github.com/owner/repo/pull/88");
    expect(metadata).toContain("status=pr_open");
  });

  it("rewrites only the actual --title when --body contains literal [agento]", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug" --body "Try: gh pr create --title [agento] your title"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain("[agento] fix: bug");
    expect(output.updatedInput?.command).toContain("Try: gh pr create --title [agento] your title");
  });

  it("allows when actual --title has [agento] even if --body contains literal [agento]", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "[agento] fix: bug" --body "Note: use [agento] prefix"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
  });

  it("PreToolUse: allowed gh pr create exits silently without updating metadata", () => {
    const { stdout, metadata } = runHook({
      command: 'gh pr create --title "[agento] fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
    expect(metadata).toBe("status=spawning\n");
  });

  it("PreToolUse: git checkout -b does NOT update branch metadata", () => {
    const { stdout, metadata } = runHook({
      command: "git checkout -b feat/new-feature",
      hookEvent: "PreToolUse",
    });
    expect(stdout.trim()).toBe("{}");
    expect(metadata).toBe("status=spawning\n");
  });

  it("prepends [agento] when using -t=<title> form in PreToolUse", () => {
    const { stdout } = runHook({
      command: 'gh pr create -t=fix --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain("-t=");
    expect(output.updatedInput?.command).toMatch(/\[agento\].*fix/);
  });

  it("fails closed when python3 is unavailable for title rewriting", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
      path: getNoPythonBinDir(),
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("python3 is required");
  });

  it("PostToolUse: detects gh pr create with env prefix and extracts PR URL", () => {
    const { metadata } = runHook({
      command: 'GH_TOKEN=ghs_xxxx gh pr create --title "[agento] fix" --body "test"',
      output: "https://github.com/owner/repo/pull/77",
    });
    expect(metadata).toContain("pr=https://github.com/owner/repo/pull/77");
    expect(metadata).toContain("status=pr_open");
  });

  it("PostToolUse gh pr create still updates metadata (no prefix check)", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "fix: bug" --body "test"',
      output: "https://github.com/owner/repo/pull/99",
      hookEvent: "PostToolUse",
    });
    expect(metadata).toContain("pr=https://github.com/owner/repo/pull/99");
    expect(metadata).toContain("status=pr_open");
  });
});
