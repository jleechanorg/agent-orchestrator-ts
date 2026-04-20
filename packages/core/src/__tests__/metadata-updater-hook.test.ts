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

  it.each([
    "gh pr create --title ok --body 'literal $(not a command)'",
    "gh pr create --title ok --body 'literal `not a command`'",
  ])("allows direct gh pr create commands with single-quoted literal substitution text: %s", (command) => {
    const output = runPreTool(command);

    expect(output.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });
});
