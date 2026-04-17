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
  it.each([
    {
      desc: "double-quoted title",
      command: 'gh pr create --title "fix: bug" --body "test"',
      expectedDecision: "allow",
      expectedTitleForm: '--title "[agento] fix: bug"',
    },
    {
      desc: "single-quoted title",
      command: "gh pr create --title 'fix: bug' --body 'test'",
      expectedDecision: "allow",
      expectedTitleForm: "--title '[agento] fix: bug'",
    },
    {
      desc: "title with spaces (double-quoted)",
      command: 'gh pr create --title "fix: bug with spaces" --body "test"',
      expectedDecision: "allow",
      expectedTitleForm: '--title "[agento] fix: bug with spaces"',
    },
    {
      desc: "-t short option",
      command: 'gh pr create -t "fix: bug" --body "test"',
      expectedDecision: "allow",
      expectedTitleForm: '-t "[agento] fix: bug"',
    },
    {
      desc: "--title= embedded style",
      command: 'gh pr create --title="fix: bug" --body "test"',
      expectedDecision: "allow",
      expectedTitleForm: '--title="[agento] fix: bug"',
    },
    {
      desc: "-t= embedded style",
      command: 'gh pr create -t="fix: bug" --body "test"',
      expectedDecision: "allow",
      expectedTitleForm: '-t="[agento] fix: bug"',
    },
    {
      desc: "-t prefix style",
      command: 'gh pr create -t"fix: bug" --body "test"',
      expectedDecision: "allow",
      expectedTitleForm: '-t"[agento] fix: bug"',
    },
  ])("rewrites $desc title to include [agento] prefix", ({ command, expectedDecision, expectedTitleForm }) => {
    const { stdout } = runHook({ command, hookEvent: "PreToolUse" });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe(expectedDecision);
    expect(output.updatedInput?.command).toMatch(new RegExp(expectedTitleForm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

  it.each([
    {
      desc: "cd && prefix",
      command: 'cd /repo && gh pr create --title "fix: bug"',
      expectedDecision: "allow",
      expectedPattern: 'cd /repo && gh pr create --title "[agento] fix: bug"',
    },
    {
      desc: "env prefix",
      command: 'GH_TOKEN=xxx gh pr create --title "fix: bug"',
      expectedDecision: "allow",
      expectedPattern: 'GH_TOKEN=xxx gh pr create --title "[agento] fix: bug"',
    },
    {
      desc: "multiple cd prefixes",
      command: 'cd /tmp && cd /repo && gh pr create --title "fix: bug"',
      expectedDecision: "allow",
      expectedPattern: '--title "[agento] fix: bug"',
    },
    {
      desc: "title with many spaces",
      command: 'gh pr create --title "fix: long title with many spaces" --body "test"',
      expectedDecision: "allow",
      expectedPattern: '--title "[agento] fix: long title with many spaces"',
    },
    {
      desc: "title with special characters",
      command: 'gh pr create --title "fix: bug [WIP] & more" --body "test"',
      expectedDecision: "allow",
      expectedPattern: '--title "[agento] fix: bug [WIP] & more"',
    },
  ])("rewrites title with $desc", ({ command, expectedDecision, expectedPattern }) => {
    const { stdout } = runHook({ command, hookEvent: "PreToolUse" });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe(expectedDecision);
    expect(output.updatedInput?.command).toMatch(new RegExp(expectedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

  it.each([
    {
      desc: "(&&)",
      command: 'echo "test" && gh pr create --title "fix"',
    },
    {
      desc: "(;)",
      command: 'echo "test" ; gh pr create --title "fix"',
    },
  ])("blocks chained command before gh pr create $desc", ({ command }) => {
    const { stdout } = runHook({ command, hookEvent: "PreToolUse" });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("cannot safely analyze chained shell commands");
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

  it("rejects malformed title argument", () => {
    const { stdout } = runHook({
      command: "gh pr create --title",
      hookEvent: "PreToolUse",
    });
    const output = parseHookOutput(stdout);
    expect(output.permissionDecision).toBe("deny");
    expect(output.permissionDecisionReason).toContain("--title");
  });
});
