/**
 * tmux command wrappers — async helpers for tmux operations.
 *
 * Uses child_process.execFile for safe command execution (no shell injection).
 */

import { execFile as _execFile } from "node:child_process";
import { setTimeout as _setTimeout } from "node:timers/promises";

/**
 * Injectable test doubles for tmux.ts.
 * execFile is directly reassignable. sleep uses a mutable ref so reassignment
 * after tmuxInject() picks up the injected setTimeout.
 */
let execFile: typeof _execFile = _execFile;
let _sleep: (ms: number) => Promise<void> = (ms) => _setTimeout(ms);

/** Wraps setTimeout — updated when tmuxInject({ setTimeout }) is called. */
const sleep = (ms: number) => _sleep(ms);

/** Inject test doubles for tmux.ts. Called by tests before exercising any tmux API. */
export function tmuxInject(doubles: { execFile?: typeof _execFile; setTimeout?: typeof _setTimeout } = {}) {
  if (doubles.execFile) execFile = doubles.execFile;
  if (doubles.setTimeout) _sleep = (ms) => doubles.setTimeout!(ms);
}
/** Run a tmux command and return stdout. */
function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        // tmux exits non-zero for many benign cases (no sessions, etc.)
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Check if tmux server is running. */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await tmux("list-sessions", "-F", "#{session_name}");
    return true;
  } catch {
    return false;
  }
}

export interface TmuxSessionInfo {
  name: string;
  created: string;
  attached: boolean;
  windows: number;
}

/** List all tmux sessions. */
export async function listSessions(): Promise<TmuxSessionInfo[]> {
  try {
    const output = await tmux(
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created_string}\t#{session_attached}\t#{session_windows}",
    );

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", created = "", attached = "0", windows = "1"] = line.split("\t");
        return {
          name,
          created,
          attached: attached !== "0",
          windows: parseInt(windows, 10) || 1,
        };
      });
  } catch {
    // No tmux server or no sessions
    return [];
  }
}

/** Check if a specific tmux session exists. */
export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    // Probe for tmux availability first — `tmux has-session` exits code 1 for BOTH
    // "session not found" and "tmux server unavailable", so we cannot distinguish
    // the two from its error alone.  list-sessions fails only when the server is
    // unavailable, making it a reliable availability check.
    await tmux("list-sessions", "-F", "#{session_name}");
  } catch {
    // Tmux server unavailable — throw so the caller can distinguish this from a
    // confirmed-dead session and apply its own fail-open / fail-closed policy.
    throw new Error("tmux server unavailable");
  }
  try {
    await tmux("has-session", "-t", sessionName);
    return true;
  } catch {
    return false;
  }
}

export interface NewSessionOptions {
  /** Session name */
  name: string;
  /** Working directory */
  cwd: string;
  /** Initial command to run */
  command?: string;
  /** Environment variables to set */
  environment?: Record<string, string>;
  /** Window width/height */
  width?: number;
  height?: number;
}

/** Create a new tmux session (detached). */
export async function newSession(opts: NewSessionOptions): Promise<void> {
  const args = ["new-session", "-d", "-s", opts.name, "-c", opts.cwd];

  // Add environment variables
  if (opts.environment) {
    for (const [key, value] of Object.entries(opts.environment)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Window size
  if (opts.width) {
    args.push("-x", String(opts.width));
  }
  if (opts.height) {
    args.push("-y", String(opts.height));
  }

  await tmux(...args);

  // Send the initial command if provided
  if (opts.command) {
    await sendKeys(opts.name, opts.command);
  }
}

/**
 * Send keys (text + Enter) to a tmux session.
 * For long/multiline messages, uses load-buffer + paste-buffer with
 * a named buffer to avoid racing on the global paste buffer.
 * Sends Escape first to clear any partial input in the agent.
 *
 * Implements adaptive delay + Enter retry for issue #373 (bd-qhf):
 * - Scales delay with message length (base + 200ms per KB, cap 2000ms)
 * - For messages >1KB, retries Enter up to 3 times if pane output unchanged
 */
export async function sendKeys(
  sessionName: string,
  text: string,
  pressEnter = true,
): Promise<void> {
  // Clear any partial input first (matches bash reference scripts)
  await tmux("send-keys", "-t", sessionName, "Escape");
  // Small delay to ensure Escape is processed before pasting
  await sleep(100);

  const isLongMessage = text.includes("\n") || text.length > 200;

  if (isLongMessage) {
    // Use a named buffer to avoid global paste buffer race conditions
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const bufferName = `ao-${randomUUID().slice(0, 8)}`;
    const tmpFile = join(tmpdir(), `ao-tmux-${bufferName}.txt`);
    writeFileSync(tmpFile, text, { encoding: "utf-8", mode: 0o600 });

    try {
      await tmux("load-buffer", "-b", bufferName, tmpFile);
      await tmux("paste-buffer", "-b", bufferName, "-d", "-t", sessionName);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  } else {
    // Use -l (literal) to prevent tmux from interpreting text as key names
    // (e.g. "Enter", "Escape", "C-c" would be treated as keypresses without -l)
    await tmux("send-keys", "-t", sessionName, "-l", text);
  }

  if (pressEnter) {
    // Adaptive delay (bd-orch2v3, bd-qhf): long/multiline messages need more time for
    // tmux to render the paste before Enter arrives. Flat 1000ms was insufficient for
    // large messages. Formula: base 1000ms + 200ms per KB (UTF-8 bytes), capped at 2000ms.
    // Uses Buffer.byteLength to correctly count UTF-8 bytes for emoji/CJK strings.
    if (isLongMessage) {
      const byteLen = Buffer.byteLength(text, "utf8");
      const delayMs = Math.min(1000 + Math.ceil(byteLen / 1000) * 200, 2000);
      await sleep(delayMs);
    }
    await tmux("send-keys", "-t", sessionName, "Enter");

    // Enter retry (issue #373): for large messages (>1KB UTF-8 bytes), verify the agent
    // started processing by checking pane output. If output didn't change, Enter was
    // swallowed — retry up to 3 times with increasing backoff.
    const byteLen = Buffer.byteLength(text, "utf8");
    if (isLongMessage && byteLen > 1000) {
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let beforeOutput: string;
        try {
          beforeOutput = await tmux("capture-pane", "-t", sessionName, "-p", "-S", "-50");
        } catch {
          // Session may have died — stop retrying
          break;
        }
        await sleep(500);
        await tmux("send-keys", "-t", sessionName, "Enter");
        let afterOutput: string;
        try {
          afterOutput = await tmux("capture-pane", "-t", sessionName, "-p", "-S", "-50");
        } catch {
          // Session may have died — stop retrying
          break;
        }
        if (afterOutput !== beforeOutput) {
          // Output changed — agent is processing, we're done
          break;
        }
        // Output unchanged — Enter was swallowed, retry with backoff
        await sleep(300 * (attempt + 1));
      }
    }
  }
}

/**
 * Capture recent output from a tmux pane.
 *
 * @param sessionName - tmux session name
 * @param lines - Number of scrollback lines to capture (default 30)
 */
export async function capturePane(sessionName: string, lines = 30): Promise<string> {
  return tmux("capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`);
}

/** Kill a tmux session. */
export async function killSession(sessionName: string): Promise<void> {
  await tmux("kill-session", "-t", sessionName);
}

/**
 * Get the TTY device for a tmux session's first pane.
 * Useful for finding processes running in the session.
 */
export async function getPaneTTY(sessionName: string): Promise<string | null> {
  try {
    const output = await tmux("list-panes", "-t", sessionName, "-F", "#{pane_tty}");
    const tty = output.trim().split("\n")[0];
    return tty || null;
  } catch {
    return null;
  }
}
