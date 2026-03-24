/**
 * Typed wrapper around the Peekaboo CLI.
 *
 * Peekaboo is a macOS accessibility tool that can list windows,
 * capture UI snapshots, and interact with UI elements.
 *
 * All operations are serialised through the queue to prevent
 * macOS accessibility API race conditions.
 *
 * Security: uses execFile (not exec) to avoid shell injection.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { enqueue } from "./queue.js";
import type {
  PeekabooWindow,
  PeekabooSeeResult,
  PeekabooClickResult,
} from "./types.js";

const execFile = promisify(execFileCb);

/** Default timeout for peekaboo CLI calls (ms). */
const PEEKABOO_TIMEOUT_MS = 15_000;

/**
 * Peekaboo binary path. Defaults to the PEEKABOO_BIN env var (for tests)
 * or "peekaboo". Override at startup with setPeekabooBin().
 */
let _peekabooBin: string = process.env["PEEKABOO_BIN"] ?? "peekaboo";

/**
 * Override the peekaboo binary path at runtime.
 *
 * Call this once during plugin initialisation. Avoids mutating
 * process.env, which can bleed across multiple runtime instances.
 */
export function setPeekabooBin(path: string): void {
  _peekabooBin = path;
}

/**
 * Run a peekaboo CLI command and parse JSON output.
 *
 * @param args - CLI arguments (e.g. ["list", "--app", "Antigravity"])
 * @returns Parsed JSON output from stdout
 */
async function run<T>(args: string[]): Promise<T> {
  const bin = _peekabooBin;
  const { stdout } = await execFile(bin, args, {
    timeout: PEEKABOO_TIMEOUT_MS,
  });
  return JSON.parse(stdout) as T;
}

/**
 * List windows for an application.
 *
 * @param app - Application name (e.g. "Antigravity")
 * @returns Array of window info
 */
export function windowList(app: string): Promise<PeekabooWindow[]> {
  return enqueue(() => run<PeekabooWindow[]>(["list", "--app", app, "--json"]));
}

/**
 * Capture a UI snapshot of a window.
 *
 * @param app - Application name
 * @param windowId - Peekaboo window ID
 * @returns Snapshot with snapshot_id and ui_elements
 */
export function see(app: string, windowId: number): Promise<PeekabooSeeResult> {
  return enqueue(() =>
    run<PeekabooSeeResult>([
      "see",
      "--app",
      app,
      "--window-id",
      String(windowId),
      "--json",
    ]),
  );
}

/**
 * Click a UI element identified by a snapshot.
 *
 * @param app - Application name
 * @param windowId - Peekaboo window ID
 * @param elementId - UI element ID from a prior `see` call
 * @param snapshotId - Snapshot ID that identified the element
 * @returns Click result
 */
export function click(
  app: string,
  windowId: number,
  elementId: string,
  snapshotId: string,
): Promise<PeekabooClickResult> {
  return enqueue(() =>
    run<PeekabooClickResult>([
      "click",
      "--app",
      app,
      "--window-id",
      String(windowId),
      "--element-id",
      elementId,
      "--snapshot-id",
      snapshotId,
      "--json",
    ]),
  );
}

/**
 * Paste text into the focused element of an application.
 *
 * @param app - Application name
 * @param text - Text to paste
 */
export function paste(app: string, text: string): Promise<void> {
  return enqueue(async () => {
    await execFile(_peekabooBin, ["paste", "--app", app, "--text", text], {
      timeout: PEEKABOO_TIMEOUT_MS,
    });
  });
}

/**
 * Press a key in the focused element of an application.
 *
 * @param app - Application name
 * @param key - Key name (e.g. "Return", "Escape")
 */
export function press(app: string, key: string): Promise<void> {
  return enqueue(async () => {
    await execFile(_peekabooBin, ["press", "--app", app, "--key", key], {
      timeout: PEEKABOO_TIMEOUT_MS,
    });
  });
}
