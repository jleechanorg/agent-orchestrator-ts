/**
 * tmux-utils.ts — shared tmux command helper for the runtime-tmux plugin.
 *
 * Extracted from index.ts and agent-liveness.ts to avoid duplication (bd-tln).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TMUX_COMMAND_TIMEOUT_MS = 5_000;

/** Run a tmux command and return stdout. */
export async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}
