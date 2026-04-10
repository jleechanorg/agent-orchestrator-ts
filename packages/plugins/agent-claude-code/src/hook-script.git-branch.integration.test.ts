import { describe, it, expect } from "vitest";
import { setupHookScriptIntegrationTest } from "./hook-script.integration-test-helpers.js";

const { runHook } = setupHookScriptIntegrationTest();

describe("hook script: git checkout -b / git switch -c", () => {
  it("detects plain git checkout -b", () => {
    const { metadata } = runHook({
      command: "git checkout -b feat/my-feature",
    });
    expect(metadata).toContain("branch=feat/my-feature");
  });

  it("detects plain git switch -c", () => {
    const { metadata } = runHook({
      command: "git switch -c fix/bug-123",
    });
    expect(metadata).toContain("branch=fix/bug-123");
  });

  it("detects git checkout -b with cd && prefix", () => {
    const { metadata } = runHook({
      command: "cd /some/project && git checkout -b feat/new-feature",
    });
    expect(metadata).toContain("branch=feat/new-feature");
  });

  it("detects git switch -c with cd && prefix", () => {
    const { metadata } = runHook({
      command: "cd ~/.worktrees/project && git switch -c fix/issue-456",
    });
    expect(metadata).toContain("branch=fix/issue-456");
  });

  it("detects git checkout -b with cd ; prefix", () => {
    const { metadata } = runHook({
      command: "cd /project ; git checkout -b feat/semicolon-test",
    });
    expect(metadata).toContain("branch=feat/semicolon-test");
  });

  it("detects git checkout -b with multiple cd prefixes", () => {
    const { metadata } = runHook({
      command: "cd /tmp && cd /project && git checkout -b feat/chained",
    });
    expect(metadata).toContain("branch=feat/chained");
  });

  it("detects git checkout -b with env prefix containing embedded equals", () => {
    const { metadata } = runHook({
      command: "TOKEN=a=b git checkout -b feat/with-equals",
    });
    expect(metadata).toContain("branch=feat/with-equals");
  });

  it("detects git checkout -b with chained env prefixes containing embedded equals", () => {
    const { metadata } = runHook({
      command: "FOO=a=b BAZ=c=d git checkout -b feat/multi-equals",
    });
    expect(metadata).toContain("branch=feat/multi-equals");
  });
});
