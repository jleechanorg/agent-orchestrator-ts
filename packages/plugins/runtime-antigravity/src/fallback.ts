/**
 * Claude Code CLI fallback executor.
 *
 * When Peekaboo operations fail (binary missing, timeout, element not found),
 * falls back to invoking `claude --dangerously-skip-permissions` via execFile.
 *
 * Security: uses execFile (not exec) to prevent shell injection.
 */

import { execFile as execFileCb } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the CLI fallback. */
export interface FallbackConfig {
  /** CLI binary path, default "claude" */
  cliBin: string;
  /** Extra CLI flags, default ["--dangerously-skip-permissions"] */
  cliFlags: string[];
  /** Max retries before giving up, default 3 */
  maxRetries: number;
}

/** Result of an `executeWithFallback` call. */
export interface FallbackResult {
  success: boolean;
  output: string;
  fallbackUsed: boolean;
  error?: string;
  /** PID of the CLI fallback process, if one was spawned. */
  pid?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: FallbackConfig = {
  cliBin: "claude",
  cliFlags: ["--dangerously-skip-permissions"],
  maxRetries: 3,
};

/** CLI execution timeout (ms). */
const CLI_TIMEOUT_MS = 120_000;

/**
 * Patterns in primary output that indicate a Peekaboo failure
 * warranting a CLI fallback.
 */
const ERROR_PATTERNS: RegExp[] = [
  /element not found/i,
  /window not found/i,
  /peekaboo.*failed/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the primary output looks like a Peekaboo error. */
function isPrimaryFailure(output: string): boolean {
  return ERROR_PATTERNS.some((p) => p.test(output));
}

/** Result of a single CLI invocation. */
interface CliInvokeResult {
  output: string;
  pid: number | undefined;
}

/**
 * Invoke the Claude Code CLI once.
 *
 * @returns stdout and PID on success, throws on failure
 */
function invokeCli(
  task: string,
  workspacePath: string,
  config: FallbackConfig,
): Promise<CliInvokeResult> {
  return new Promise<CliInvokeResult>((resolve, reject) => {
    const args = [...config.cliFlags, "-p", task];

    const child = execFileCb(
      config.cliBin,
      args,
      { cwd: workspacePath, timeout: CLI_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        // child.pid is captured at spawn time — safe to read in callback.
        resolve({ output: String(stdout ?? ""), pid: child.pid });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a task via Peekaboo first, fall back to Claude Code CLI on failure.
 *
 * 1. Calls `primaryFn()`.
 * 2. If it throws or returns error indicators, spawns `claude` CLI.
 * 3. Retries the CLI up to `maxRetries` times on transient failures.
 *
 * @param primaryFn  - Async function that performs the Peekaboo operation.
 * @param task       - Human-readable task description passed to the CLI.
 * @param workspacePath - Working directory for the CLI process.
 * @param config     - Optional partial config overriding defaults.
 */
export async function executeWithFallback(
  primaryFn: () => Promise<string>,
  task: string,
  workspacePath: string,
  config?: Partial<FallbackConfig>,
): Promise<FallbackResult> {
  const merged: FallbackConfig = { ...DEFAULT_CONFIG, ...config };

  // --- Try primary (Peekaboo) -------------------------------------------
  let primaryOutput: string | undefined;
  let needsFallback = false;

  try {
    primaryOutput = await primaryFn();
    if (isPrimaryFailure(primaryOutput)) {
      needsFallback = true;
    }
  } catch {
    needsFallback = true;
  }

  if (!needsFallback && primaryOutput !== undefined) {
    return { success: true, output: primaryOutput, fallbackUsed: false };
  }

  // --- CLI fallback with retries ----------------------------------------
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= merged.maxRetries; attempt++) {
    try {
      const result = await invokeCli(task, workspacePath, merged);
      return { success: true, output: result.output, fallbackUsed: true, pid: result.pid };
    } catch (err: unknown) {
      lastError =
        err instanceof Error ? err.message : String(err);
    }
  }

  return {
    success: false,
    output: "",
    fallbackUsed: true,
    error: lastError ?? "CLI fallback exhausted retries",
  };
}
