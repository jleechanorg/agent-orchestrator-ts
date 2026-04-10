import { describe, it, expect } from "vitest";
import { setupHookScriptIntegrationTest, PR_URL } from "./hook-script.integration-test-helpers.js";

const { runHook } = setupHookScriptIntegrationTest();

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
