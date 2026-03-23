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
import {
  AGENT_ALIVE_PATTERNS,
  isAgentAliveInPane,
  restartAgentCli,
  SHELL_PROMPT_PATTERNS,
} from "./agent-liveness.js";
import { tmux } from "./tmux-utils.js";

// Re-export fork-only liveness utilities so tests and external consumers
// can import from the main entry point (bd-tln)
export { isAgentAliveInPane, restartAgentCli } from "./agent-liveness.js";

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

/**
 * Send content into a tmux pane using load-buffer/paste-buffer (for long text)
 * or send-keys -l (for short literal text).
 */
/**
 * Check whether the pane shows the agent has started processing — either
 * via alive-token presence OR output no longer matching the sent content.
 * Returns true if the agent appears active; false if the pane is unchanged
 * (Enter was likely swallowed and needs retrying).
 */
async function didAgentStart(sessionId: string, message: string, isLong: boolean): Promise<boolean> {
  let paneOutput: string;
  try {
    paneOutput = await tmux("capture-pane", "-t", sessionId, "-p", "-S", "-20");
  } catch {
    // Session may have died — stop retrying
    return true;
  }
  const trimmedOutput = paneOutput.trimEnd();
  if (AGENT_ALIVE_PATTERNS.some((p) => p.test(trimmedOutput))) {
    return true;
  }
  if (isLong) {
    // Long: pane must not still end with the pasted message tail
    const messageTail = message.slice(-80).trim();
    return !trimmedOutput.endsWith(messageTail);
  } else {
    // Short: pane's last non-empty line must not still end with the message.
    // Using endsWith (not full equality) to match the long-message strategy —
    // avoids false-negatives when scrollback precedes the last line.
    const lines = trimmedOutput.split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lines[lines.length - 1] ?? "";
    const messageTail = message.trimEnd();
    return !lastLine.endsWith(messageTail);
  }
}

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

  // Enter retry (bd-orch2v3, bd-qhf): for ALL messages, check if the agent
  // started responding. If the pane is unchanged (no alive token, output matches
  // what we sent), Enter was swallowed — retry up to 3 times.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1000);
    if (await didAgentStart(sessionId, message, isLong)) {
      break;
    }
    // Enter was swallowed — send it again
    await tmux("send-keys", "-t", sessionId, "Enter");
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

/**
 * Send a message to a tmux pane and verify delivery.
 * - Adaptive delay before Enter (scales with UTF-8 byte size of message)
 * - Enter retry loop for long messages: checks pane for agent response
 *   and retries Enter up to 3 times if the paste appears to have been swallowed.
 *
 * Fork-only logic (bd-orch2v3, bd-qhf).
 */
async function doSendWithRetry(handle: RuntimeHandle, message: string): Promise<void> {
  // Clear any partial input
  await tmux("send-keys", "-t", handle.id, "C-u");

  const isLong = message.includes("\n") || message.length > 200;
  await sendContent(handle.id, message);

  // Adaptive delay (bd-orch2v3, bd-qhf): long messages need more time for
  // tmux to render the paste before Enter arrives. Flat 300ms was insufficient
  // for messages >~8KB — Enter arrived before paste completed, causing 8 sessions
  // (ao-411 through ao-420) to require manual Enter.
  // Formula: base 1000ms + 200ms per KB (UTF-8 bytes), capped at 2000ms.
  const byteLen = Buffer.byteLength(message, "utf8");
  const delayMs = isLong ? Math.min(1000 + Math.ceil(byteLen / 1000) * 200, 2000) : 300;
  await sleep(delayMs);
  await tmux("send-keys", "-t", handle.id, "Enter");

  // Enter retry (bd-orch2v3, bd-qhf): for long messages, check if the agent
  // started responding. Only the LAST 5 NON-EMPTY LINES are checked for agent
  // activity — stale activity tokens in old scrollback must not mask the
  // current state. If the pane still ends with the pasted message tail and
  // shows no recent agent activity, Enter was swallowed — retry up to 3 times.
  if (isLong) {
    const messageTail = message.slice(-80).trim();
    // Guard: if trimmed tail is empty (e.g. 80+ trailing whitespace), skip
    // the retry check — every string endsWith("") so the check would always fail.
    const shouldRetry = messageTail.length > 0;
    for (let attempt = 0; attempt < 3 && shouldRetry; attempt++) {
      await sleep(1_000);
      let paneOutput: string;
      try {
        paneOutput = await tmux("capture-pane", "-t", handle.id, "-p", "-S", "-20");
      } catch {
        // Session may have died; stop retrying
        break;
      }
      const trimmedOutput = paneOutput.trimEnd();
      // Agent has started if: any RECENT activity token is present (last 5 lines),
      // OR the pane no longer ends with our message tail.
      const recentLines = trimmedOutput.split("\n").filter((l) => l.trim().length > 0).slice(-5);
      const hasRecentActivity = recentLines.some((line) =>
        AGENT_ALIVE_PATTERNS.some((p) => p.test(line)),
      );
      const agentStarted = hasRecentActivity || !trimmedOutput.endsWith(messageTail);
      if (agentStarted) {
        break;
      }
      // Enter was swallowed — send it again
      await tmux("send-keys", "-t", handle.id, "Enter");
    }
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
            try {
              await tmux("delete-buffer", "-b", bufferName);
            } catch {
              /* Buffer may already be deleted by -d flag — that's fine */
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

      // Send message + Enter (with Enter-retry loop for long messages)
      await doSendWithRetry(handle, message);

      // Post-send dead-agent check (bd-tln): after sending, verify the agent
      // picked up the message. Short messages: 500ms wait (reduces throughput
      // penalty for healthy agents). Long messages: 2000ms (paste needs time).
      const isLong = message.includes("\n") || message.length > 200;
      await sleep(isLong ? 2_000 : 500);
      const agentAliveAfter = await isAgentAliveInPane(handle.id);
      if (!agentAliveAfter) {
        await restartAgentCli(handle);
        // Retry: send message again using the same doSendWithRetry logic
        await doSendWithRetry(handle, message);
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
