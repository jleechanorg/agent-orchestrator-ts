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
 */
export async function execAo(args: string[], cwd?: string): Promise<CliResult> {
  return new Promise((resolve) => {
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
      resolve({
        success: code === 0,
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
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

  if (options.task) {
    args.push(options.task);
  }
  if (options.issue) {
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
 */
export async function aoSend(options: SendOptions): Promise<CliResult> {
  const args: string[] = ["send", options.session];

  if (options.message) {
    args.push("--", ...options.message.split(" "));
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
export async function aoSessionList(options: SessionListOptions = {}): Promise<CliResult> {
  const args: string[] = ["session", "ls"];

  if (options.project) {
    args.push("--project", options.project);
  }

  return execAo(args);
}

/**
 * Kill an AO session.
 */
export async function aoSessionKill(options: SessionKillOptions): Promise<CliResult> {
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
 * Get session status/attach info.
 */
export async function aoSessionInfo(session: string): Promise<CliResult> {
  return execAo(["session", "ls"]);
}
