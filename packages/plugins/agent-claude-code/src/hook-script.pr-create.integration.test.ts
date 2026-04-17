import { describe, it, expect } from "vitest";
import { setupHookScriptIntegrationTest, PR_URL } from "./hook-script.integration-test-helpers.js";

const { runHook, parseHookOutput, getNoPythonBinDir } = setupHookScriptIntegrationTest();

describe("hook script: gh pr create", () => {
  it("detects plain gh pr create", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "fix" --body "test" --base master',
      output: `Creating pull request...\n${PR_URL}\n`,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with cd && prefix", () => {
    const { metadata } = runHook({
      command: 'cd ~/.worktrees/mercury/cleanup && gh pr create --title "fix" --base master',
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with cd ; prefix", () => {
    const { metadata } = runHook({
      command: 'cd /some/path ; gh pr create --title "test" --body "body"',
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with single env prefix containing embedded equals", () => {
    const { metadata } = runHook({
      command: "FOO=a=b gh pr create --title '[agento] fix'",
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with multiple chained env prefixes containing embedded equals", () => {
    const { metadata } = runHook({
      command: "FOO=a=b BAZ=c=d gh pr create --title '[agento] fix'",
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with quoted env values that contain spaces", () => {
    const { metadata } = runHook({
      command: 'FOO="a b" BAR=\'c d\' gh pr create --title "[agento] fix"',
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with multiple chained cd prefixes", () => {
    const { metadata } = runHook({
      command: 'cd /tmp && cd ~/.worktrees/mercury && gh pr create --title "fix" --base master',
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("detects gh pr create with cd and env prefixes before the guarded command", () => {
    const { metadata } = runHook({
      command: 'cd ~/.worktrees/mercury/cleanup && GH_TOKEN=ghs_xxxx gh pr create --title "[agento] fix" --base master',
      output: PR_URL,
    });
    expect(metadata).toContain(`pr=${PR_URL}`);
    expect(metadata).toContain("status=pr_open");
  });

  it("does NOT update metadata when PR URL is missing from output", () => {
    const { metadata } = runHook({
      command: 'gh pr create --title "fix"',
      output: "Error: something went wrong",
    });
    expect(metadata).not.toContain("pr=");
    expect(metadata).toContain("status=spawning");
  });
});

describe("hook script: gh pr create PreToolUse [agento] prefix rewriting", () => {
  it("rewrites gh pr create title without [agento] prefix to include it", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("allows gh pr create when title already has [agento] prefix", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "[agento] fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBeUndefined();
    expect(output.updatedInput).toBeUndefined();
  });

  it("rewrites title with -t short option", () => {
    const { stdout } = runHook({
      command: 'gh pr create -t "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("rewrites title with --title= embedded style", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title="fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("rewrites title with -t= embedded style", () => {
    const { stdout } = runHook({
      command: 'gh pr create -t="fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("rewrites title with -t prefix style", () => {
    const { stdout } = runHook({
      command: 'gh pr create -t"fix: bug" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("rewrites single-quoted title", () => {
    const { stdout } = runHook({
      command: "gh pr create --title 'fix: bug' --body 'test'",
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("preserves double-quoted title when rewriting", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug with spaces" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug with spaces');
  });

  it("denies gh pr create without --title option", () => {
    const { stdout } = runHook({
      command: 'gh pr create --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("--title");
  });

  it("rewrites title with cd && prefix", () => {
    const { stdout } = runHook({
      command: 'cd /repo && gh pr create --title "fix: bug"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('cd /repo && gh pr create --title "[agento] fix: bug"');
  });

  it("rewrites title with env prefix", () => {
    const { stdout } = runHook({
      command: 'GH_TOKEN=xxx gh pr create --title "fix: bug"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('GH_TOKEN=xxx gh pr create --title "[agento] fix: bug"');
  });

  it("blocks chained command before gh pr create (&&)", () => {
    const { stdout } = runHook({
      command: 'echo "test" && gh pr create --title "fix"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("cannot safely analyze chained shell commands");
  });

  it("blocks chained command before gh pr create (;)", () => {
    const { stdout } = runHook({
      command: 'echo "test" ; gh pr create --title "fix"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("cannot safely analyze chained shell commands");
  });

  it("allows multiple cd prefixes before gh pr create", () => {
    const { stdout } = runHook({
      command: 'cd /tmp && cd /repo && gh pr create --title "fix: bug"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug');
  });

  it("falls back to bash regex when python3 is unavailable", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug" --body "test"',
      hookEvent: "PreToolUse",
      path: getNoPythonBinDir(),
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("python3");
  });

  it("preserves spaces in quoted titles during rewrite", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: long title with many spaces" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: long title with many spaces');
  });

  it("handles title with special characters", () => {
    const { stdout } = runHook({
      command: 'gh pr create --title "fix: bug [WIP] & more" --body "test"',
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("allow");
    expect(output.updatedInput?.command).toContain('[agento] fix: bug [WIP] & more');
  });

  it("rejects malformed title argument", () => {
    const { stdout } = runHook({
      command: "gh pr create --title",
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
  });
});
