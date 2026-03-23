/**
 * agent-liveness.ts — Fork-only dead-agent detection and restart logic.
 *
 * Exported symbols are used by index.ts (sendMessage, restartAgentCli).
 * Not upstreamed to ComposioHQ (bd-tln).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeHandle } from "@jleechanorg/ao-core";
import { tmux } from "./tmux-utils.js";

/**
 * Bash/shell prompt patterns that indicate the agent CLI has exited and the
 * shell has taken over. These are intentionally conservative — false-negatives
 * (incorrectly concluding agent is alive) are less harmful than false-positives
 * (incorrectly killing a live agent).
 *
 * Fork-only logic (bd-tln): not upstreamed to ComposioHQ.
 */
export const SHELL_PROMPT_PATTERNS = [
  /(?:^|[\s\w@~.-])\$\s*$/, // bash: word/path then "$ " (avoids "$100")
  /%\s*$/, // zsh: ends with "% "
  /❯\s*$/, // starship / oh-my-zsh: ends with "❯ "
  /(?:^|\s)>\s*$/, // fish: space before ">" (avoids "Click here >")
  /#\s*$/, // root bash: ends with "# "
];

/**
 * Tokens that indicate the agent CLI is alive and processing. Seeing any of
 * these means the agent has taken over from bash.
 *
 * Fork-only logic (bd-tln).
 */
export const AGENT_ALIVE_PATTERNS = [
  /✻/, // Claude Code "thinking" spinner
  /✶/, // Claude Code alternative spinner
  /✳/, // Claude Code spinner variant
  /●/, // Claude Code tool use / progress
  /◆/, // Claude Code tool indicator
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // Braille spinner (codex / generic)
  /Thinking\.\.\./i, // Explicit thinking text
  /Running tool/i, // Tool use in progress
];

/**
 * Detect whether the agent CLI is still alive in the given tmux pane.
 *
 * Strategy (detection order matters — fixes stale-token masking):
 *  1. Capture the last 30 lines of pane output.
 *  2. Check the LAST NON-EMPTY line for a shell prompt pattern → dead if matched.
 *  3. Check a TRAILING WINDOW (last 5 lines) for any agent-alive token → alive if found.
 *  4. Otherwise → assume alive (conservative).
 *
 * Order is critical: a stale "✻ Thinking" in earlier lines must not mask a
 * shell prompt on the final line (which indicates the agent has already exited).
 * Only a RECENT activity token in the last 5 lines counts as proof of liveness.
 *
 * Fork-only logic (bd-tln).
 */
export async function isAgentAliveInPane(sessionName: string): Promise<boolean> {
  let paneOutput: string;
  try {
    paneOutput = await tmux("capture-pane", "-t", sessionName, "-p", "-S", "-30");
  } catch {
    // If we can't capture the pane, the session is dead
    return false;
  }

  // Step 1: Check the last non-empty line for shell prompt patterns FIRST.
  // A shell prompt on the last line means the agent has exited — even if stale
  // activity tokens appear earlier in the buffer.
  const lines = paneOutput.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1] ?? "";
    for (const pattern of SHELL_PROMPT_PATTERNS) {
      if (pattern.test(lastLine)) {
        return false;
      }
    }
  }

  // Step 2: Only search a trailing window (last 5 non-empty lines) for agent-alive
  // tokens. A stale spinner/tool indicator in old scrollback must not override the
  // current prompt state — only recent activity counts.
  const recentLines = lines.slice(-5);
  for (const line of recentLines) {
    for (const pattern of AGENT_ALIVE_PATTERNS) {
      if (pattern.test(line)) {
        return true;
      }
    }
  }

  // No conclusive indicator → assume alive (conservative default).
  return true;
}

/**
 * Attempt to restart the agent CLI inside a tmux session after detecting that
 * it has died and the shell has taken over.
 *
 * Steps:
 *  1. Send C-c twice to cancel any partial input and return to a clean prompt.
 *  2. Re-send the original launch command.
 *  3. Poll for up to 30s with exponential backoff for the agent to show a ready/alive indicator.
 *
 * Fork-only logic (bd-tln).
 */
export async function restartAgentCli(handle: RuntimeHandle): Promise<void> {
  const launchCommand = handle.data.launchCommand as string | undefined;
  if (!launchCommand) {
    throw new Error(
      `Cannot restart agent CLI in session "${handle.id}": launchCommand not stored in handle.data`,
    );
  }

  // Cancel any partially-pasted text / in-progress command
  await tmux("send-keys", "-t", handle.id, "C-c");
  await sleep(200);
  await tmux("send-keys", "-t", handle.id, "C-c");
  await sleep(300);

  // Re-launch the agent CLI using the same strategy as the initial launch
  if (launchCommand.length > 200) {
    const bufferName = `ao-launch-${randomUUID().slice(0, 8)}`;
    const tmpPath = join(tmpdir(), `ao-launch-${randomUUID()}.txt`);
    writeFileSync(tmpPath, launchCommand, { encoding: "utf-8", mode: 0o600 });
    try {
      await tmux("load-buffer", "-b", bufferName, tmpPath);
      await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore cleanup errors */
      }
      try {
        await tmux("delete-buffer", "-b", bufferName);
      } catch {
        /* Buffer may already be deleted by -d flag — that's fine */
      }
    }
    await sleep(300);
    await tmux("send-keys", "-t", handle.id, "Enter");
  } else {
    // Use -l (literal) so tokens like "Enter" in the command aren't interpreted as keypresses
    await tmux("send-keys", "-t", handle.id, "-l", launchCommand);
    await sleep(300);
    await tmux("send-keys", "-t", handle.id, "Enter");
  }

  // Poll up to 30s with exponential backoff: 1s, 2s, 4s, 5s, 5s, 5s (total ~22s)
  const pollIntervals = [1_000, 2_000, 4_000, 5_000, 5_000, 5_000];
  for (const interval of pollIntervals) {
    // Immediate first check (interval 0 = 0ms delay), then sleep between subsequent checks
    if (interval > 0) {
      await sleep(interval);
    }
    const alive = await isAgentAliveInPane(handle.id);
    if (alive) {
      return;
    }
  }

  // Extract executable name without env-prefix tokens (e.g. "NODE_ENV=production node")
  const tokens = launchCommand.trim().split(/\s+/);
  let executable = "agent";
  for (const token of tokens) {
    // Skip tokens that are env assignments (e.g. "NODE_ENV=production", "FOO=bar")
    if (/^[a-zA-Z_][a-zA-Z0-9_]*=/u.test(token)) {
      continue;
    }
    // First non-assignment token is the executable
    executable = token.split("/").pop() ?? token;
    break;
  }

  throw new Error(
    `Agent CLI did not restart within 30s in session "${handle.id}" (command: ${executable})`,
  );
}
