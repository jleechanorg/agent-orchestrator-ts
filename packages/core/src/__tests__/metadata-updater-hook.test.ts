import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

type HookDecision = {
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hookScript = join(repoRoot, ".claude", "metadata-updater.sh");

function runPreTool(command: string): HookDecision {
  const dataDir = mkdtempSync(join(tmpdir(), "ao-metadata-hook-"));
  try {
    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      exit_code: 0,
      hook_event_name: "PreToolUse",
    });

    const stdout = execFileSync("/bin/bash", [hookScript], {
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        AO_DATA_DIR: dataDir,
        AO_SESSION: "test-session",
      },
    });

    return JSON.parse(stdout || "{}") as HookDecision;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("metadata-updater PreToolUse guarded command parsing", () => {
  it.each([
    "echo $(gh pr merge --auto 123)",
    "echo `gh pr create --title '[agento] bypass'`",
    'echo $(echo ")" && gh pr merge --auto 123)',
    'echo $(eval "gh pr merge --auto 123")',
    "echo 'text\\' $(gh pr merge --auto 123)",
    'echo "don\'t $(gh pr merge --auto 123)"',
  ])("denies guarded gh commands hidden in command substitution: %s", (command) => {
    const output = runPreTool(command);

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(
      "command substitution cannot safely hide gh pr create or gh pr merge",
    );
  });

  it.each([
    "cd /tmp || gh pr merge 123",
    "cd /tmp | gh pr merge 123",
    "cd /tmp | 'gh' pr merge 123",
    'cd /tmp | "gh" pr create --title test --body body',
  ])("denies guarded gh commands after unsafe cd operators: %s", (command) => {
    const output = runPreTool(command);

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(
      "cannot safely analyze chained shell commands",
    );
  });

  it.each([
    "( gh pr merge --auto 123 )",
    "{ gh pr create --title test --body body; }",
    "cat <(gh pr merge --auto 123)",
  ])("denies guarded gh commands hidden by shell grouping/redirection: %s", (command) => {
    const output = runPreTool(command);

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(
      "cannot safely analyze chained shell commands",
    );
  });

  it("does not deny unrelated command substitution", () => {
    const output = runPreTool("echo $(date)");

    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("does not deny substitution with quoted guarded literal (printf)", () => {
    const output = runPreTool('echo $(printf "%s" "gh pr merge")');

    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it.each([
    '"gh" pr merge --auto 123',
    'gh "pr" merge --auto 123',
    "'gh' pr create --title test --body body",
    'gh pr "create" --title test --body body',
  ])("allows direct guarded gh commands with quoted keywords: %s", (command) => {
    const output = runPreTool(command);

    expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it.each([
    "gh pr create --title ok --body 'literal $(not a command)'",
    "gh pr create --title ok --body 'literal `not a command`'",
  ])("allows direct gh pr create commands with single-quoted literal substitution text: %s", (command) => {
    const output = runPreTool(command);

    expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("denies env assignment before guarded command via &&", () => {
    const output = runPreTool("FOO=bar && gh pr merge --auto 123");

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain(
      "gh pr create or gh pr merge",
    );
  });

  it("denies env assignment before guarded command via ;", () => {
    const output = runPreTool("FOO=bar ; gh pr create --title t --body b");

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows env assignment before unguarded command via &&", () => {
    const output = runPreTool("FOO=bar && echo hello");

    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  // Regression: PR #731 removed guarded_merge_context_pattern from .claude/metadata-updater.sh,
  // weakening the regex-level guardrail. This test exercises the bash regex directly so the
  // layered defense stays in lockstep with the bash merge_pattern, independent of the
  // Python helper or the upstream-side strip chains.
  describe("guarded_merge_context_pattern regex (defense in depth)", () => {
    const guardedMergeContextPattern =
      "(\\$\\(|`|\\||\\(|\\{|<\\(|&&|;)[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)";

    // Run the regex through bash so we exercise the exact POSIX ERE semantics the script
    // uses (avoids JS regex escaping pitfalls with $ \\ ` | ( {).
    const matches = (cmd: string): boolean => {
      const result = execFileSync(
        "/bin/bash",
        ["-c", '[[ "$1" =~ $2 ]] && echo MATCH || echo NOMATCH', "x", cmd, guardedMergeContextPattern],
        { encoding: "utf8" },
      );
      return result.trim() === "MATCH";
    };

    it("matches && chained gh pr merge", () => {
      expect(matches("pre1 && gh pr merge 123")).toBe(true);
      expect(matches("cd /tmp && gh pr merge 123")).toBe(true);
    });

    it("matches ; chained gh pr merge", () => {
      expect(matches("pre1 ; gh pr merge 123")).toBe(true);
    });

    it("matches pipe chained gh pr merge", () => {
      expect(matches("pre1 | gh pr merge 123")).toBe(true);
    });

    it("matches subshell/grouped gh pr merge", () => {
      expect(matches("( gh pr merge 123 )")).toBe(true);
      expect(matches("{ gh pr merge 123; }")).toBe(true);
    });

    it("matches command substitution gh pr merge", () => {
      expect(matches("echo $( gh pr merge 123 )")).toBe(true);
      expect(matches("echo ` gh pr merge 123 `")).toBe(true);
    });

    it("matches process substitution gh pr merge", () => {
      expect(matches("cat <( gh pr merge 123 )")).toBe(true);
    });

    it("does not match unrelated commands", () => {
      expect(matches("echo hello")).toBe(false);
      expect(matches("gh pr create --title t --body b")).toBe(false);
      expect(matches("FOO=bar && echo hi")).toBe(false);
    });

    it("is wired into the merge guard (regex present in script)", () => {
      const script = execFileSync("cat", [hookScript], { encoding: "utf8" });
      expect(script).toContain("guarded_merge_context_pattern=");
      expect(script).toMatch(
        /clean_command" =~ \$merge_pattern \|\| "\$clean_command" =~ \$guarded_merge_context_pattern/,
      );
    });
  });
});
