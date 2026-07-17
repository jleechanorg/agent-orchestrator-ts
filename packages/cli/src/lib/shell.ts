import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

/**
 * Like `exec` but does NOT throw on non-zero exit — returns the captured
 * stdout/stderr and a separate `code` so callers (e.g. `preflight.checkGhAuth`)
 * can classify failures by the actual command output instead of just
 * "exit code != 0". Pre-qcr9 the preflight treated every non-zero exit as
 * "not authenticated" and missed transient HTTP 403/429 rate-limit cases.
 */
export async function execOrError(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  try {
    const result = await exec(cmd, args, options);
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: (e.stdout ?? "").trimEnd(),
      stderr: (e.stderr ?? "").trimEnd(),
      code: e.code ?? null,
    };
  }
}

export async function execSilent(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args);
    return stdout;
  } catch {
    return null;
  }
}

export async function tmux(...args: string[]): Promise<string | null> {
  return execSilent("tmux", args);
}

export async function git(args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout;
  } catch {
    return null;
  }
}

export async function gh(args: string[]): Promise<string | null> {
  return execSilent("gh", args);
}

export async function getTmuxSessions(): Promise<string[]> {
  const output = await tmux("list-sessions", "-F", "#{session_name}");
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

export async function getTmuxActivity(session: string): Promise<number | null> {
  const output = await tmux("display-message", "-t", session, "-p", "#{session_activity}");
  if (!output) return null;
  const ts = parseInt(output, 10);
  return isNaN(ts) ? null : ts * 1000;
}
