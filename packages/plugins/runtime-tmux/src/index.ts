import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  type AttachInfo,
  shellEscape,
} from "@jleechanorg/ao-core";
import { AGENT_ALIVE_PATTERNS, isAgentAliveInPane, restartAgentCli } from "./agent-liveness.js";
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

/** Safety cap on the number of bashrc exports we'll inject. Beyond this we
 * log a warning that lists the dropped var names (count only, never values)
 * and continue without those vars. The cap is intentionally large (10_000) —
 * real-world bashrcs export 100-300 vars; pathological cases hit the cap with
 * a loud warning rather than silent truncation. */
const MAX_BASHRC_VARS = 10_000;

/**
 * Parse `declare -x KEY=VALUE` lines from `bash -ic 'declare -x'` output.
 * Handles double-quoted, single-quoted, and unquoted values, and unescapes
 * backslash-escaped characters inside double-quoted values so that values
 * like `\$HOME` and `\"foo\"` round-trip back to their original bytes
 * (Codex P2 — see PR #691 review). Skips entries with empty values (passing
 * `-e KEY=` to tmux would override any inherited default to empty, which
 * is rarely what we want).
 */
/**
 * Decode Bash backslash escapes — applies to both `"..."` (double-quoted)
 * and `$'...'` (ANSI-C) emit forms. The same escape set is used for both,
 * plus `\'` which only appears in `$'...'` (a literal `'` inside double
 * quotes is emitted unescaped by bash, but inside `$'...'` bash uses
 * `\'` to escape the single quote that would otherwise terminate the
 * literal). Full set: `\$`, `\"`, `\\`, `\'`, `` \` ``, `\n`, `\r`, `\t`,
 * `\v`, `\f`, `\a`, `\b`, `\e`, and octal `\0`-`\7`.
 * Single-quoted `'...'` values never receive this transform.
 */
function unescapeBashString(s: string): string {
  return s.replace(/\\([\\$"'`nrtvfabe0-7])/g, (_, ch) => {
    switch (ch) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "v": return "\v";
      case "f": return "\f";
      case "a": return "\x07";
      case "b": return "\b";
      case "e": return "\x1b";
      case "\\": return "\\";
      case "$": return "$";
      case '"': return '"';
      case "'": return "'";
      case "`": return "`";
      default: return ch; // \0-\7: pass through (octal)
    }
  });
}

function parseBashrcOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof output !== "string" || output.length === 0) return result;
  for (const line of output.split("\n")) {
    const m = line.match(/^declare -x ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].replace(/\s+$/, "");
    let value: string;
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      // Bash double-quoted: process ANSI-C backslash escapes (\$, \", \\, \n, etc.)
      value = unescapeBashString(raw.slice(1, -1));
    } else if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      // Bash single-quoted: literal — no escape processing.
      value = raw.slice(1, -1);
    } else if (
      raw.length >= 3 &&
      raw.startsWith("$'") &&
      raw.endsWith("'")
    ) {
      // Bash ANSI-C $'...': same escape rules as the double-quoted branch.
      // Bash emits this form for any export whose value contains a literal
      // newline, tab, or other non-printable byte (e.g. $'a\nb').
      value = unescapeBashString(raw.slice(2, -1));
    } else {
      // Unquoted: take as-is.
      value = raw;
    }
    if (value.length === 0) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Source the user's `~/.bashrc` and return the exports it sets, as a plain
 * object suitable for merging into the tmux session's environment.
 *
 * `tmux new-session -d` starts a non-interactive, non-login shell that does
 * NOT source `~/.bashrc` or `~/.bash_profile`. As a result, any secrets or
 * PATH additions exported from bashrc (`AO_BOT_GH_TOKEN`, `GH_TOKEN_AGENT1`,
 * `MINIMAX_API_KEY`, custom PATH entries, etc.) are missing from worker
 * shells. This helper runs an interactive `bash -ic` so bashrc IS sourced
 * (Codex P2: bash reads ~/.bashrc automatically for an interactive shell —
 * we let bash handle that once instead of double-sourcing it), dumps the
 * resulting environment with `declare -x`, and parses the output back into
 * a key→value map.
 *
 * Mirrors the proven pattern in `scripts/launchd-launcher.sh` (commit
 * 504a347) used to inject the same set of vars into launchd plists.
 *
 * Non-fatal: returns `{}` on any failure (HOME unset, bash missing, bashrc
 * missing, parse error). The caller falls back to whatever was in
 * `config.environment`.
 *
 * Cap: at most `MAX_BASHRC_VARS` (10_000) entries are returned. If the user's
 * bashrc exports more, the dropped var names are listed in a warning log so
 * the user can identify why an expected env var is missing (CodeRabbit MAJOR
 * — see PR #691 review).
 */
async function loadBashrcEnv(): Promise<Record<string, string>> {
  if (!process.env.HOME) return {};
  let output: string;
  try {
    // Use async execFile so we don't block the Node event loop on session
    // creation (CodeRabbit MAJOR — see PR #691 review). `--norc` is NOT
    // passed: bash sources ~/.bashrc for an interactive shell exactly once.
    const result = await execFileAsync(
      "bash",
      ["-ic", "declare -x"],
      {
        encoding: "utf-8",
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    output = result.stdout;
  } catch {
    // bash missing, bashrc unreadable, or timeout — non-fatal.
    return {};
  }
  if (typeof output !== "string") return {};
  const result = parseBashrcOutput(output);
  const keys = Object.keys(result);
  if (keys.length > MAX_BASHRC_VARS) {
    const dropped = keys.slice(MAX_BASHRC_VARS);
    console.warn(
      `[runtime-tmux] bashrc exported ${keys.length} vars (> ${MAX_BASHRC_VARS} cap); ` +
        `dropped ${dropped.length} vars: ${dropped.join(", ")}`,
    );
    const truncated: Record<string, string> = {};
    for (const k of keys.slice(0, MAX_BASHRC_VARS)) {
      truncated[k] = result[k];
    }
    return truncated;
  }
  if (keys.length > 0) {
    // Log the count only — never log values (they may contain secrets).
    console.warn(`[runtime-tmux] loaded ${keys.length} vars from ~/.bashrc`);
  }
  return result;
}

/**
 * Detect if the agent is Gemini CLI by inspecting the launch command.
 * Gemini doesn't handle C-u clear or paste-buffer well — needs direct send-keys.
 */
function isGeminiAgent(handle: RuntimeHandle): boolean {
  const launchCommand =
    typeof handle.data?.launchCommand === "string" ? handle.data.launchCommand : "";
  return (
    launchCommand.toLowerCase().includes("gemini") || launchCommand.toLowerCase().includes("agy")
  );
}

/**
 * Poll until the agy/Gemini CLI shows its ready prompt (the "> " input line
 * surrounded by "────" delimiters), or until the timeout expires.
 *
 * Root cause (orch-f3ok): agy takes ~2-3s to render its splash screen before
 * accepting input. The AO lifecycle manager calls sendMessage() immediately
 * after create() returns. Because AGENT_ALIVE_PATTERNS only covers Claude Code
 * and codex spinners, isAgentAliveInPane() returns true (conservative fallback)
 * while agy is still mid-splash — send-keys fires into an unready terminal and
 * the keystrokes are lost.
 *
 * Fix: create() calls this for agy sessions to block until the CLI is ready.
 */
async function waitForGeminiReady(sessionName: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 300;
  // agy's input line is always preceded by a "────" separator. We detect readiness
  // by looking for that separator followed by ">" on the next non-empty line.
  const readyPattern = /─{10,}[\s\S]*?\n\s*>\s*(\n|$)/;
  while (Date.now() < deadline) {
    await sleep(pollInterval);
    let paneOutput: string;
    try {
      paneOutput = await tmux("capture-pane", "-t", sessionName, "-p", "-S", "-20");
    } catch {
      // Transient capture error — keep polling until deadline. A single
      // failure doesn't prove the session died (tmux may be briefly busy).
      continue;
    }
    if (readyPattern.test(paneOutput)) {
      return true;
    }
  }
  return false; // Timed out — Enter-retry loop in doSendWithRetry will recover
}

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/**
 * Shell snippet appended after the agent launch command so the tmux pane
 * (and therefore the tmux session) survives agent exit. Without this, the
 * pane closes when the agent process exits, the only window goes away, and
 * the whole tmux session dies — leaving the dashboard with a phantom
 * "runtime lost" state and the user with no way to do anything in that
 * workspace (issue #1756).
 *
 * `exec` replaces the wrapping sh/bash with the user's interactive shell,
 * so the lifecycle manager still detects agent termination via
 * `agent.isProcessRunning` and transitions the session correctly.
 */
const KEEP_ALIVE_SHELL = `exec "\${SHELL:-/bin/bash}" -i`;

function withKeepAliveShell(command: string): string {
  return `${command.replace(/\n+$/, "")}\n${KEEP_ALIVE_SHELL}`;
}

/** Single-quote a value for safe export in a bash env file. */
function shellQuoteValue(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function writeLaunchScript(command: string, envFilePrefix = ""): string {
  const scriptPath = join(tmpdir(), `ao-launch-${randomUUID()}.sh`);
  const content = `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${envFilePrefix}${withKeepAliveShell(command)}\n`;
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
  return `bash ${shellEscape(scriptPath)}`;
}

/**
 * Send content into a tmux pane using load-buffer/paste-buffer (for long text)
 * or send-keys -l (for short literal text).
 *
 * For Gemini agents: always use send-keys -l directly, even for long messages,
 * to avoid C-u/paste-buffer issues that cause Gemini to not process prompts.
 */
async function sendContent(sessionId: string, content: string, forGemini = false): Promise<void> {
  // Gemini: always use send-keys -l directly (C-u is skipped in caller for gemini)
  if (forGemini) {
    // Gemini CLI handles multiline better with multiple send-keys calls per line
    // But simplest approach: send the whole thing as -l literal
    await tmux("send-keys", "-t", sessionId, "-l", content);
    return;
  }

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
 * - For Gemini agents: skip C-u clear and use direct send-keys (no paste-buffer)
 *   as Gemini CLI doesn't handle input clearing/paste reliably.
 *
 * Fork-only logic (bd-orch2v3, bd-qhf).
 */
async function doSendWithRetry(handle: RuntimeHandle, message: string): Promise<void> {
  const forGemini = isGeminiAgent(handle);
  // When waitForGeminiReady timed out, geminiReady is false — apply Enter-retry
  // even for short messages so the first sendMessage call isn't silently dropped.
  const geminiTimedOut = forGemini && handle.data?.geminiReady === false;

  // Clear any partial input — but NOT for Gemini (C-u interferes with prompt delivery)
  if (!forGemini) {
    await tmux("send-keys", "-t", handle.id, "C-u");
  }

  const isLong = message.includes("\n") || message.length > 200;
  await sendContent(handle.id, message, forGemini);

  // Adaptive delay (bd-orch2v3, bd-qhf): long messages need more time for
  // tmux to render the paste before Enter arrives. Flat 300ms was insufficient
  // for messages >~8KB — Enter arrived before paste completed, causing 8 sessions
  // (ao-411 through ao-420) to require manual Enter.
  // Formula: base 1000ms + 200ms per KB (UTF-8 bytes), capped at 2000ms.
  // Gemini: use longer delay since it processes slower
  const byteLen = Buffer.byteLength(message, "utf8");
  const baseDelay = forGemini ? 2000 : 300;
  const delayMs = isLong ? Math.min(1000 + Math.ceil(byteLen / 1000) * 200, 2000) : baseDelay;
  await sleep(delayMs);
  await tmux("send-keys", "-t", handle.id, "Enter");

  // Enter retry (bd-orch2v3, bd-qhf): for long messages OR short Gemini messages
  // where the ready-poll timed out, check if the agent started responding.
  // Only the LAST 5 NON-EMPTY LINES are checked for agent activity — stale
  // activity tokens in old scrollback must not mask the current state.
  // If the pane shows no recent agent activity, Enter was swallowed — retry up to 3x.
  if (isLong || geminiTimedOut) {
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
      const hasQueuedMessage = trimmedOutput.includes("Press up to edit queued messages");
      // Agent has started if: any RECENT activity token is present (last 5 lines),
      // OR the pane no longer ends with our message tail.
      const recentLines = trimmedOutput
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(-5);
      const hasRecentActivity = recentLines.some((line) =>
        AGENT_ALIVE_PATTERNS.some((p) => p.test(line)),
      );
      const agentStarted = hasRecentActivity || !trimmedOutput.endsWith(messageTail);
      // Force the first Enter-retry when geminiTimedOut: the agentStarted
      // heuristic is unreliable during splash rendering because the pane
      // shows the splash screen (not our message), so !endsWith(messageTail)
      // is true even though Enter hasn't actually been processed yet.
      const forceRetry = geminiTimedOut && attempt === 0;
      if (agentStarted && !hasQueuedMessage && !forceRetry) {
        // Agent responded — clear the timedOut flag so subsequent short
        // messages don't get unnecessary Enter-retry treatment.
        if (handle.data) handle.data.geminiReady = true;
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

      // Source bashrc-sourced env vars (bd-l5ty): tmux new-session starts a
      // non-interactive non-login shell that does NOT source ~/.bashrc, so
      // secrets exported from bashrc (AO_BOT_GH_TOKEN, GH_TOKEN_AGENT1, …)
      // are missing from worker shells unless we inject them explicitly.
      // Mirrors the proven pattern in scripts/launchd-launcher.sh.
      const bashrcEnv = await loadBashrcEnv();
      // Explicit per-session config.environment takes precedence over bashrc.
      // config.environment vars are small (caller-controlled) — safe as -e args.
      // bashrc vars can be 100-300 entries; passing them all as -e args exceeds
      // tmux's per-line arg buffer and causes the session to hang (bd-l5ty-overflow).
      // Instead, write bashrc vars to a temp env file and source it in the shell.
      const configEnv = config.environment ?? {};
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(configEnv)) {
        if (value === "") continue;
        envArgs.push("-e", `${key}=${value}`);
      }

      // Write bashrc env to a sourced file when non-empty to avoid overflow.
      let bashrcEnvFilePrefix = "";
      // Exclude bashrc keys that are overridden by config.environment so the
      // explicit value (in -e args) is not shadowed when the env file is sourced.
      const bashrcEntries = Object.entries(bashrcEnv).filter(
        ([k, v]) => v !== "" && !(k in configEnv),
      );
      if (bashrcEntries.length > 0) {
        const envFilePath = join(tmpdir(), `ao-bashrc-${sessionName}.sh`);
        const lines = bashrcEntries.map(([k, v]) => `export ${k}=${shellQuoteValue(v)}`);
        writeFileSync(envFilePath, lines.join("\n") + "\n", {
          encoding: "utf-8",
          mode: 0o600,
        });
        bashrcEnvFilePrefix = `. ${shellEscape(envFilePath)}\n`;
      }

      // Start the launch command as the pane's initial command instead of
      // typing into a live shell. A dashboard attach can trigger terminal
      // device responses; if those race with tmux send-keys, they become
      // literal shell input and corrupt the launch path. The keep-alive
      // tail is appended in both code paths — see KEEP_ALIVE_SHELL.
      const launchCmd = config.launchCommand;
      const shellCommand =
        launchCmd.length > 200
          ? writeLaunchScript(launchCmd, bashrcEnvFilePrefix)
          : `${bashrcEnvFilePrefix}${withKeepAliveShell(launchCmd)}`;

      // Try creating the session first. If tmux reports a duplicate session name,
      // kill the stale session and retry. This avoids destroying a live session
      // before we know the replacement can be created successfully.
      const createSession = (): Promise<string> =>
        tmux(
          "new-session",
          "-d",
          "-s",
          sessionName,
          "-c",
          config.workspacePath,
          ...envArgs,
          shellCommand,
        );
      try {
        await createSession();
      } catch (createErr: unknown) {
        const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
        // tmux reports "duplicate session: <name>" when a session with that name exists.
        if (!errMsg.includes("duplicate session")) {
          throw createErr;
        }
        // Stale session collision — kill the old one and retry.
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Ignore if session disappeared between check and kill.
        }
        await createSession();
      }

      // Hide the tmux status bar — sessions are embedded in the web terminal,
      // and the green bar at the bottom is visual noise (and racy with the
      // web layer's own set-option call, which only fires on WebSocket connect).
      // Kill the session if this fails so we don't leave an orphaned tmux process.
      try {
        await tmux("set-option", "-t", sessionName, "status", "off");
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to configure session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      // Prevent tmux from renaming windows automatically (e.g. on process
      // changes). The dashboard and AO rely on stable window names for
      // session tracking — automatic renames break pane targeting.
      try {
        await tmux("set-option", "-t", sessionName, "allow-rename", "off");
        await tmux("set-option", "-t", sessionName, "automatic-rename", "off");
      } catch {
        // Non-fatal: window naming is cosmetic, not critical for functionality
      }

      // Wait for agy/Gemini to reach its ready prompt before returning the handle
      // (orch-f3ok). Without this, the lifecycle manager calls sendMessage()
      // immediately and the initial task keystrokes land during the splash screen
      // render — where they are swallowed. All other agents start synchronously
      // or accept stdin before their first output, so only Gemini needs this gate.
      const launchCmdLower = config.launchCommand.toLowerCase();
      const isGeminiLaunch = launchCmdLower.includes("agy") || launchCmdLower.includes("gemini");
      // false = timed out or session died before ready; doSendWithRetry uses this
      // to apply Enter-retry even for short messages on the first sendMessage call.
      const geminiReady = isGeminiLaunch ? await waitForGeminiReady(sessionName) : true;

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
          // Store launchCommand so restartAgentCli() can re-launch after a crash (bd-tln)
          launchCommand: config.launchCommand,
          geminiReady,
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

    async sendKeys(handle: RuntimeHandle, key: string): Promise<void> {
      // Send a key without clearing the input buffer (unlike sendMessage which calls C-u first).
      // Used to confirm queued messages that are pending submission.
      await tmux("send-keys", "-t", handle.id, key);
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

    async isAvailable(): Promise<boolean> {
      try {
        await tmux("-V");
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

    async getRestartCommand(handle: RuntimeHandle): Promise<string> {
      const cmd = handle.data.launchCommand as string | undefined;
      if (!cmd) {
        throw new Error(
          `getRestartCommand: launchCommand not stored in handle.data for session "${handle.id}"`,
        );
      }
      return cmd;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
