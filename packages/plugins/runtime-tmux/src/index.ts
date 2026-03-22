import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@jleechanorg/ao-core";

const execFileAsync = promisify(execFile);
const TMUX_COMMAND_TIMEOUT_MS = 5_000;

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

/**
 * Bash/shell prompt patterns that indicate the agent CLI has exited and the
 * shell has taken over. These are intentionally conservative — false-negatives
 * (incorrectly concluding agent is alive) are less harmful than false-positives
 * (incorrectly killing a live agent).
 *
 * Patterns are anchored to avoid matching mid-line text like "$100" or "Click here >".
 * They are checked only against the LAST non-empty line of pane output.
 *
 * Fork-only logic (bd-tln): not upstreamed to ComposioHQ.
 */
const SHELL_PROMPT_PATTERNS = [
  /(?:^|[\s\w@~\/.-])\$\s*$/, // bash: word/path then "$ " (avoids "$100")
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
const AGENT_ALIVE_PATTERNS = [
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
 * Strategy (order matters — shell prompt check FIRST to avoid stale spinner masking):
 *  1. Capture the last 30 lines of pane output.
 *  2. Check the LAST non-empty line for a shell prompt pattern → dead immediately.
 *     This prevents stale "✻ Thinking" history from masking a crashed agent.
 *  3. Only if no shell prompt, check buffer for agent-alive tokens → alive.
 *  4. Otherwise → assume alive (conservative).
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

  // Check the last non-empty line for shell prompt patterns FIRST.
  // A shell prompt on the last line means the agent exited — even if stale
  // agent tokens appear earlier in the buffer history.
  const lines = paneOutput.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    // Empty pane — conservative: assume alive
    return true;
  }
  const lastLine = lines[lines.length - 1] ?? "";
  for (const pattern of SHELL_PROMPT_PATTERNS) {
    if (pattern.test(lastLine)) {
      return false;
    }
  }

  // No shell prompt on last line — check buffer for alive tokens
  for (const pattern of AGENT_ALIVE_PATTERNS) {
    if (pattern.test(paneOutput)) {
      return true;
    }
  }

  // No conclusive indicator — assume alive
  return true;
}

/**
 * Attempt to restart the agent CLI inside a tmux session after detecting that
 * it has died and the shell has taken over.
 *
 * Steps:
 *  1. Send C-c twice to cancel any partial input and return to a clean prompt.
 *  2. Re-send the original launch command.
 *  3. Poll up to 30s for the agent to show a ready/alive indicator.
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
    }
    await sleep(300);
    await tmux("send-keys", "-t", handle.id, "Enter");
  } else {
    // Use -l (literal) so tokens like "Enter" in the command aren't interpreted as keypresses
    await tmux("send-keys", "-t", handle.id, "-l", launchCommand);
    await sleep(300);
    await tmux("send-keys", "-t", handle.id, "Enter");
  }

  // Poll up to 30s (6 × 5s intervals) for the agent to show an alive indicator
  const pollIntervalMs = 5_000;
  const maxAttempts = 6;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollIntervalMs);
    const alive = await isAgentAliveInPane(handle.id);
    if (alive) {
      return;
    }
  }

  // If still not alive after 30s, throw — redact full command to avoid leaking secrets
  const executable = launchCommand.split(" ")[0] ?? "agent";
  throw new Error(
    `Agent CLI did not restart within 30s in session "${handle.id}" (command: ${executable})`,
  );
}

/**
 * Send content + Enter into a tmux pane, including the Enter-retry loop for
 * long messages. Extracted as a shared helper so both the initial send and the
 * post-restart resend path use identical logic.
 *
 * Fork-only logic (bd-tln).
 */
async function doSend(sessionId: string, message: string): Promise<void> {
  const isLong = message.includes("\n") || message.length > 200;
  await sendContent(sessionId, message);

  // Adaptive delay: long messages need more time for tmux to render the paste
  // before Enter arrives. Short messages keep 300ms.
  const delayMs = isLong
    ? Math.min(1000 + Math.ceil(message.length / 1000) * 200, 2000)
    : 300;
  await sleep(delayMs);
  await tmux("send-keys", "-t", sessionId, "Enter");

  // Enter retry (bd-orch2v3, bd-qhf): for long messages, check if the agent
  // started responding. If the pane still ends with the pasted message tail
  // and shows no agent activity tokens, Enter was swallowed — retry up to 3 times.
  if (isLong) {
    const messageTail = message.slice(-80).trim();
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1000);
      let paneOutput: string;
      try {
        paneOutput = await tmux("capture-pane", "-t", sessionId, "-p", "-S", "-20");
      } catch {
        // Session may have died; stop retrying
        break;
      }
      const trimmedOutput = paneOutput.trimEnd();
      // Agent has started if: any activity token is present, OR the pane no
      // longer ends with our message tail (agent overwrote or responded).
      const agentStarted =
        AGENT_ALIVE_PATTERNS.some((p) => p.test(trimmedOutput)) ||
        !trimmedOutput.endsWith(messageTail);
      if (agentStarted) {
        break;
      }
      // Enter was swallowed — send it again
      await tmux("send-keys", "-t", sessionId, "Enter");
    }
  }
}

/** Send content into a tmux pane using the load-buffer/paste-buffer or send-keys method. */
async function sendContent(sessionId: string, content: string): Promise<void> {
  if (content.includes("\n") || content.length > 200) {
    const bufferName = `ao-${randomUUID()}`;
    const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    try {
      await tmux("load-buffer", "-b", bufferName, tmpPath);
      await tmux("paste-buffer", "-b", bufferName, "-t", sessionId, "-d");
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      try {
        await tmux("delete-buffer", "-b", bufferName);
      } catch {
        // Buffer may already be deleted by -d flag — that's fine
      }
    }
  } else {
    // Use -l (literal) so text like "Enter" or "Space" isn't interpreted
    // as tmux key names
    await tmux("send-keys", "-t", sessionId, "-l", content);
  }
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);

      // Send the launch command — clean up the session if this fails.
      // Use load-buffer + paste-buffer for long commands to avoid tmux/zsh
      // truncation issues (commands >200 chars get mangled by send-keys).
      try {
        if (config.launchCommand.length > 200) {
          const bufferName = `ao-launch-${randomUUID().slice(0, 8)}`;
          const tmpPath = join(tmpdir(), `ao-launch-${randomUUID()}.txt`);
          writeFileSync(tmpPath, config.launchCommand, { encoding: "utf-8", mode: 0o600 });
          try {
            await tmux("load-buffer", "-b", bufferName, tmpPath);
            await tmux("paste-buffer", "-b", bufferName, "-t", sessionName, "-d");
          } finally {
            try {
              unlinkSync(tmpPath);
            } catch {
              /* ignore cleanup errors */
            }
          }
          await sleep(300);
          await tmux("send-keys", "-t", sessionName, "Enter");
        } else {
          await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");
        }
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send launch command to session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
          // Store launchCommand so restartAgentCli() can re-launch after a crash (bd-tln)
          launchCommand: config.launchCommand,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // Session may already be dead — that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Dead-agent CLI detection (bd-tln): check if the agent CLI is still alive
      // before sending. If the shell has taken over (agent exited), attempt to
      // restart the agent CLI before delivering the message.
      const agentAlive = await isAgentAliveInPane(handle.id);
      if (!agentAlive) {
        await restartAgentCli(handle);
      }

      // Clear any partial input
      await tmux("send-keys", "-t", handle.id, "C-u");

      // Send message + Enter (with Enter-retry loop for long messages)
      await doSend(handle.id, message);

      // Post-send dead-agent check (bd-tln): after sending, verify the agent
      // picked up the message. Short messages: 500ms wait (reduces throughput
      // penalty for healthy agents). Long messages: 2000ms (paste needs time).
      const isLong = message.includes("\n") || message.length > 200;
      await sleep(isLong ? 2_000 : 500);
      const agentAliveAfter = await isAgentAliveInPane(handle.id);
      if (!agentAliveAfter) {
        // The message was pasted into bash — clear it and retry after restart
        await restartAgentCli(handle);
        // Retry: clear, send message, press Enter (same logic as initial send via doSend)
        await tmux("send-keys", "-t", handle.id, "C-u");
        await doSend(handle.id, message);
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux("capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        await tmux("has-session", "-t", handle.id);
        return true;
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `tmux attach -t ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
