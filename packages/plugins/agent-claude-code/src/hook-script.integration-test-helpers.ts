import { beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
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

function lookupCommandOnPath(command: string): string {
  const pathValue = process.env.PATH ?? "";

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }

    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH entries until we find an executable match.
    }
  }

  throw new Error(`${command} missing`);
}

export function symlinkAvailableCommands(
  commands: string[],
  binDir: string,
  deps: {
    lookupCommand?: (command: string) => string;
    symlink?: (target: string, path: string) => void;
  } = {},
) {
  const lookupCommand = deps.lookupCommand ?? lookupCommandOnPath;
  const createSymlink = deps.symlink ?? symlinkSync;

  for (const command of commands) {
    try {
      const commandPath = lookupCommand(command);
      if (commandPath) {
        createSymlink(commandPath, join(binDir, command));
      }
    } catch {
      // Optional in the integration harness: the script already has tool fallbacks.
    }
  }
}

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
    symlinkAvailableCommands(["cat", "grep", "cut", "jq", "head", "sed", "cp", "mv"], noPythonBinDir);
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
