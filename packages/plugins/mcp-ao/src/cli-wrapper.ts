/**
 * CLI wrapper for ao operations.
 * Wraps the ao CLI commands for spawn, send, session, etc.
 */

import { spawn } from "node:child_process";

export interface SpawnOptions {
  task?: string;
  issue?: string;
  project?: string;
  agent?: string;
  runtime?: string;
  open?: boolean;
  claimPr?: string;
}

export interface SendOptions {
  session: string;
  message: string;
  file?: string;
  wait?: boolean;
  timeout?: number;
}

export interface SessionListOptions {
  project?: string;
}

export interface SessionKillOptions {
  session: string;
  keepSession?: boolean;
  purgeSession?: boolean;
}

export interface CliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute an ao CLI command and return the result.
 * Default timeout of 30 seconds to avoid hanging MCP tool calls.
 */
export async function execAo(
  args: string[],
  cwd?: string,
  timeoutMs = 30000,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        success: false,
        stdout: "",
        stderr: `Command timed out after ${timeoutMs}ms`,
        exitCode: 124,
      });
    }, timeoutMs);

    const proc = spawn("ao", args, {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0,
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout,
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

/**
 * Spawn a new AO session.
 */
export async function aoSpawn(options: SpawnOptions): Promise<CliResult> {
  const args: string[] = ["spawn"];

  // task and issue are mutually exclusive - both fill the same [first] positional arg
  // task takes precedence as it's more general (can be a task description or issue ID)
  if (options.task) {
    args.push(options.task);
  } else if (options.issue) {
    args.push(options.issue);
  }
  if (options.project) {
    args.push("--project", options.project);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.runtime) {
    args.push("--runtime", options.runtime);
  }
  if (options.open) {
    args.push("--open");
  }
  if (options.claimPr) {
    args.push("--claim-pr", options.claimPr);
  }

  return execAo(args);
}

/**
 * Send a message to an AO session.
 * The ao CLI expects message parts after "--" to be joined with spaces.
 */
export async function aoSend(options: SendOptions): Promise<CliResult> {
  const args: string[] = ["send", options.session];

  if (options.message) {
    // Pass message as a single argument after "--" so spaces are preserved
    args.push("--", options.message);
  }
  if (options.file) {
    args.push("--file", options.file);
  }
  if (options.wait === false) {
    args.push("--no-wait");
  }
  if (options.timeout !== undefined) {
    args.push("--timeout", String(options.timeout));
  }

  return execAo(args);
}

/**
 * List AO sessions.
 */
export async function aoSessionList(
  options: SessionListOptions = {},
): Promise<CliResult> {
  const args: string[] = ["session", "ls"];

  if (options.project) {
    args.push("--project", options.project);
  }

  return execAo(args);
}

/**
 * Kill an AO session.
 */
export async function aoSessionKill(
  options: SessionKillOptions,
): Promise<CliResult> {
  const args: string[] = ["session", "kill", options.session];

  if (options.keepSession) {
    args.push("--keep-session");
  }
  if (options.purgeSession) {
    args.push("--purge-session");
  }

  return execAo(args);
}

/**
 * Get session status for a specific session.
 * Note: ao session ls does not filter by individual session,
 * so this returns the full list filtered in the result.
 */
export async function aoSessionInfo(session: string): Promise<CliResult> {
  const result = await execAo(["session", "ls"]);

  if (result.success && session) {
    // Filter output to only show lines containing the session name
    const lines = result.stdout.split("\n").filter(
      (line) => line.includes(session),
    );
    return {
      ...result,
      stdout: lines.join("\n"),
    };
  }

  return result;
}
