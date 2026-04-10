import { beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { METADATA_UPDATER_SCRIPT } from "./index.js";

export type HookOutput = {
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: { command?: string };
  systemMessage?: string;
};

type HookOutputEnvelope = {
  hookSpecificOutput?: Omit<HookOutput, "systemMessage">;
  systemMessage?: string;
};

export const PR_URL = "https://github.com/owner/repo/pull/42";

export function setupHookScriptIntegrationTest() {
  let testDir = "";
  let hookScriptPath = "";
  let noPythonBinDir = "";

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "ao-hook-test-"));
    hookScriptPath = join(testDir, "metadata-updater.sh");
    writeFileSync(hookScriptPath, METADATA_UPDATER_SCRIPT, { mode: 0o755 });
    noPythonBinDir = join(testDir, "bin-without-python");
    mkdirSync(noPythonBinDir, { recursive: true });
    for (const command of ["cat", "jq", "grep", "cut"]) {
      const commandPath = execSync(`command -v ${command}`, { encoding: "utf-8" }).trim();
      symlinkSync(commandPath, join(noPythonBinDir, command));
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runHook(opts: {
    command: string;
    toolName?: string;
    output?: string;
    exitCode?: number;
    metadataContent?: string;
    allowMerge?: boolean;
    hookEvent?: string;
    path?: string;
  }): { stdout: string; metadata: string } {
    const sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionsDir = join(testDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const metadataFile = join(sessionsDir, sessionId);
    writeFileSync(metadataFile, opts.metadataContent ?? "status=spawning\n");

    const inputJson: Record<string, unknown> = {
      tool_name: opts.toolName ?? "Bash",
      tool_input: { command: opts.command },
      tool_response: opts.output ?? "",
      exit_code: opts.exitCode ?? 0,
      hook_event_name: opts.hookEvent ?? "PostToolUse",
    };
    const input = JSON.stringify(inputJson);

    let stdout: string;
    try {
      stdout = execSync(`/bin/bash "${hookScriptPath}"`, {
        input,
        env: {
          ...process.env,
          AO_SESSION: sessionId,
          AO_DATA_DIR: sessionsDir,
          AO_ALLOW_GH_PR_MERGE: opts.allowMerge ? "1" : undefined,
          AO_HOOK_EVENT_NAME: opts.hookEvent ?? "PostToolUse",
          HOME: testDir,
          PATH: opts.path ?? process.env.PATH,
        },
        encoding: "utf-8",
        timeout: 5000,
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      stdout = e.stdout ?? "";
    }

    let metadata: string;
    try {
      metadata = readFileSync(metadataFile, "utf-8");
    } catch {
      metadata = "";
    }

    return { stdout, metadata };
  }

  function parseHookOutput(stdout: string): HookOutput {
    const parsed = JSON.parse(stdout.trim()) as HookOutputEnvelope;
    return {
      ...parsed.hookSpecificOutput,
      systemMessage: parsed.systemMessage,
    };
  }

  return {
    runHook,
    parseHookOutput,
    getNoPythonBinDir: () => noPythonBinDir,
  };
}
