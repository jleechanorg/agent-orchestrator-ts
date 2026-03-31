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
  PeekabooListResponse,
  PeekabooSeeResponse,
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
 * @param args - CLI arguments (e.g. ["list", "windows", "--app", "Antigravity"])
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
 * CLI: `peekaboo list windows --app <app> --json`
 * Output envelope: `{data: {targetApplication, windows: [...]}}`
 *
 * @param app - Application name (e.g. "Antigravity")
 * @returns Array of window info (unwrapped from envelope)
 */
export function windowList(app: string): Promise<PeekabooWindow[]> {
  return enqueue(async () => {
    const envelope = await run<PeekabooListResponse>([
      "list",
      "windows",
      "--app",
      app,
      "--json",
    ]);
    return envelope.data.windows;
  });
}

/**
 * Capture a UI snapshot of a window.
 *
 * CLI: `peekaboo see --app <app> --window-id <id> --json`
 * Output envelope: `{success: true, data: {snapshot_id, ui_elements: [...]}}`
 *
 * @param app - Application name
 * @param windowId - Peekaboo window ID
 * @returns Snapshot with snapshot_id and ui_elements (unwrapped from envelope)
 */
export function see(app: string, windowId: number): Promise<PeekabooSeeResult> {
  return enqueue(async () => {
    const envelope = await run<PeekabooSeeResponse>([
      "see",
      "--app",
      app,
      "--window-id",
      String(windowId),
      "--json",
    ]);
    return envelope.data;
  });
}

/**
 * Click a UI element identified by a snapshot.
 *
 * CLI: `peekaboo click --app <app> --window-id <id> --on <elementId> --snapshot <snapshotId> --json`
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
      "--on",
      elementId,
      "--snapshot",
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
 * Press a single key in the focused element of an application.
 *
 * CLI: `peekaboo press <key> --app <app>`
 * For key combinations (e.g. cmd+w), use hotkey() instead.
 *
 * @param app - Application name
 * @param key - Key name (e.g. "Return", "Escape")
 */
export function press(app: string, key: string): Promise<void> {
  return enqueue(async () => {
    await execFile(_peekabooBin, ["press", key, "--app", app], {
      timeout: PEEKABOO_TIMEOUT_MS,
    });
  });
}

/**
 * Press a key combination (hotkey) in the focused element of an application.
 *
 * CLI: `peekaboo hotkey <combo> --app <app>`
 * Use this for modifier combos like "cmd+w", "cmd+l".
 * For single keys, use press() instead.
 *
 * @param app - Application name
 * @param combo - Key combination (e.g. "cmd+w", "cmd+l")
 */
export function hotkey(app: string, combo: string): Promise<void> {
  return enqueue(async () => {
    await execFile(_peekabooBin, ["hotkey", combo, "--app", app], {
      timeout: PEEKABOO_TIMEOUT_MS,
    });
  });
}

/**
 * Scroll within a window.
 *
 * CLI: `peekaboo scroll --app <app> --window-id <id> --direction <dir> --amount <n>`
 *
 * @param app - Application name
 * @param windowId - Peekaboo window ID
 * @param direction - Scroll direction (e.g. "up", "down")
 * @param amount - Scroll amount in lines/units
 */
export function scroll(
  app: string,
  windowId: number,
  direction: string,
  amount: number,
): Promise<void> {
  return enqueue(async () => {
    await execFile(
      _peekabooBin,
      [
        "scroll",
        "--app",
        app,
        "--window-id",
        String(windowId),
        "--direction",
        direction,
        "--amount",
        String(amount),
      ],
      { timeout: PEEKABOO_TIMEOUT_MS },
    );
  });
}

/**
 * Capture a region of the screen using macOS `screencapture`.
 *
 * CLI: `screencapture -R<x>,<y>,<w>,<h> <outputPath>`
 * Uses point coordinates (not retina pixels).
 *
 * @param x - Screen X coordinate (points)
 * @param y - Screen Y coordinate (points)
 * @param width - Capture width (points)
 * @param height - Capture height (points)
 * @param outputPath - Path to save the PNG
 * @returns The raw PNG file contents as a Buffer
 */
export function screencapture(
  x: number,
  y: number,
  width: number,
  height: number,
  outputPath: string,
): Promise<Buffer> {
  return enqueue(async () => {
    await execFile(
      "screencapture",
      [`-R${x},${y},${width},${height}`, outputPath],
      { timeout: PEEKABOO_TIMEOUT_MS },
    );
    const fs = await import("node:fs/promises");
    return fs.readFile(outputPath);
  });
}

/**
 * Click at screen-absolute coordinates within a window.
 *
 * CLI: `peekaboo click --app <app> --window-id <id> --coords <x>,<y> --json`
 * Coordinates are screen-absolute points (not pixels).
 *
 * @param app - Application name
 * @param windowId - Peekaboo window ID
 * @param x - Screen X coordinate (points)
 * @param y - Screen Y coordinate (points)
 */
export function clickCoordinates(
  app: string,
  windowId: number,
  x: number,
  y: number,
): Promise<PeekabooClickResult> {
  return enqueue(() =>
    run<PeekabooClickResult>([
      "click",
      "--app",
      app,
      "--window-id",
      String(windowId),
      "--coords",
      `${x},${y}`,
      "--json",
    ]),
  );
}
