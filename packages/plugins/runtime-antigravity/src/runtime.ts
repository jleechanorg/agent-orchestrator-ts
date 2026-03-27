/**
 * Antigravity Runtime — implements the ao-core Runtime interface.
 *
 * Drives the Antigravity IDE via Peekaboo macOS accessibility API
 * to create conversations, send messages, and capture output.
 */

import type {
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@jleechanorg/ao-core";
import * as peekaboo from "./peekaboo.js";
import { executeWithFallback, type FallbackConfig } from "./fallback.js";
import { createPoller } from "./poller.js";
import { runPreflight } from "./preflight.js";
import type { AntigravitySession } from "./types.js";
import { defaultConfig, type AntigravityConfig } from "./config.js";

/** Application name for Peekaboo targeting. */
const APP_NAME = "Antigravity";

/** Max scroll attempts when looking for a workspace in the Manager sidebar. */
const MAX_SCROLL_ATTEMPTS = 5;

/**
 * Delay (ms) after scrolling to allow UI to settle.
 * Exposed for testing via setScrollSettleMs().
 */
let _scrollSettleMs = 500;

/** Override the scroll settle delay (for tests). */
export function setScrollSettleMs(ms: number): void {
  _scrollSettleMs = ms;
}

/** Extract basename from a path for workspace matching. */
function workspaceBasename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/**
 * Find a workspace element in the Manager sidebar, scrolling if needed.
 * The Manager sidebar only shows a viewport — workspaces may be off-screen.
 */
async function findWorkspaceElement(
  managerWindowId: number,
  workspacePath: string,
): Promise<{
  element: { id: string; role: string; title: string; label: string };
  snapshotId: string;
}> {
  const basename = workspaceBasename(workspacePath).toLowerCase();

  for (let attempt = 0; attempt <= MAX_SCROLL_ATTEMPTS; attempt++) {
    const snapshot = await peekaboo.see(APP_NAME, managerWindowId);
    if (snapshot?.ui_elements) {
      const match = snapshot.ui_elements.find(
        (el) =>
          el.title.toLowerCase().includes(basename) ||
          el.label.toLowerCase().includes(basename),
      );
      if (match) {
        return { element: match, snapshotId: snapshot.snapshot_id };
      }
    }

    // Not found — scroll down and retry
    if (attempt < MAX_SCROLL_ATTEMPTS) {
      await peekaboo.scroll(APP_NAME, managerWindowId, "down", 5);
      await new Promise((r) => setTimeout(r, _scrollSettleMs));
    }
  }

  throw new Error(
    `Workspace "${workspacePath}" (basename: "${basename}") not found in Antigravity Manager after ${MAX_SCROLL_ATTEMPTS} scroll attempts`,
  );
}

/**
 * Find the Send button in a snapshot's UI elements.
 * Antigravity's Send button is more reliable than pressing Return.
 */
function findSendButton(
  elements: Array<{ id: string; role: string; title: string; label: string }>,
): { id: string } | undefined {
  return elements.find(
    (el) =>
      el.label === "Send" ||
      el.title === "Send" ||
      (el.role === "button" && el.label.toLowerCase() === "send"),
  );
}

/**
 * Create an AntigravityRuntime instance.
 *
 * Follows the same factory pattern as the tmux runtime.
 *
 * @param config - Optional validated config. Falls back to defaults.
 */
export function createAntigravityRuntime(config?: AntigravityConfig): Runtime {
  const runtimeConfig = config ?? defaultConfig();
  // Wire configured peekaboo binary path into the module-level variable
  // via the explicit setter (avoids mutating process.env which can bleed
  // across multiple runtime instances).
  peekaboo.setPeekabooBin(runtimeConfig.peekabooBin);

  // Single shared poller for all sessions on this runtime instance.
  // Polls the Manager window (not per-conversation windows) for spinner state.
  // onIdle forwards to the per-session callback stored in handle.data["onIdle"].
  const poller = createPoller(runtimeConfig.pollIntervalMs, {
    onIdle: (handle) => {
      const cb = handle.data["onIdle"] as ((id: string) => void) | undefined;
      if (cb) cb(handle.id);
    },
    onCapacityWait: () => {
      // Caller subscribes via lifecycle events when needed.
    },
  });

  return {
    name: "antigravity",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const fallbackCfg: Partial<FallbackConfig> = {
        cliBin: runtimeConfig.fallbackCliBin,
        cliFlags: runtimeConfig.fallbackCliFlags,
        maxRetries: runtimeConfig.fallbackMaxRetries,
      };

      const primaryFn = async (): Promise<string> => {
        // Run preflight to validate the runtime environment.
        // On failure, throw so executeWithFallback routes to CLI.
        const preflight = await runPreflight();
        if (!preflight.ok) {
          const failedStep = preflight.steps[preflight.steps.length - 1];
          throw new Error(
            `Preflight failed [${failedStep.name}]: ${failedStep.error ?? "unknown"}`,
          );
        }

        // 1. Find the Antigravity Manager window
        const windows = await peekaboo.windowList(APP_NAME);
        const managerWindow = windows.find((w) =>
          w.title.toLowerCase().includes("manager"),
        );
        if (!managerWindow) {
          throw new Error(
            "Antigravity Manager window not found. Is Antigravity running?",
          );
        }

        // 2. Find workspace in Manager sidebar (scrolls if needed)
        const { element: workspaceElement, snapshotId: wsSnapshotId } =
          await findWorkspaceElement(
            managerWindow.window_id,
            config.workspacePath,
          );

        // 3. Click the workspace to open a new conversation
        await peekaboo.click(
          APP_NAME,
          managerWindow.window_id,
          workspaceElement.id,
          wsSnapshotId,
        );

        // 4. Find the conversation window — match by workspace basename,
        //    not just "not Manager" (avoids picking wrong window in
        //    multi-workspace scenarios)
        const wsBasename = workspaceBasename(config.workspacePath).toLowerCase();
        const postClickWindows = await peekaboo.windowList(APP_NAME);
        let conversationWindow = postClickWindows.find(
          (w) =>
            w.window_id !== managerWindow.window_id &&
            w.title.toLowerCase().includes(wsBasename),
        );
        // Fallback: any non-Manager, non-Launchpad, non-hidden window
        if (!conversationWindow) {
          conversationWindow = postClickWindows.find(
            (w) =>
              w.window_id !== managerWindow.window_id &&
              !w.title.toLowerCase().includes("manager") &&
              !w.title.toLowerCase().includes("launchpad") &&
              !w.title.toLowerCase().includes("hidden"),
          );
        }
        if (!conversationWindow) {
          throw new Error(
            "Conversation window did not open after clicking workspace",
          );
        }

        // 5. Send the initial prompt if provided via launchCommand
        //    Use the Manager window for input (Agent Manager mode) —
        //    find text field + Send button instead of pressing Return.
        if (config.launchCommand) {
          // Re-snapshot Manager to find the text input and Send button
          const mgSnapshot = await peekaboo.see(
            APP_NAME,
            managerWindow.window_id,
          );
          const inputField = mgSnapshot.ui_elements.find(
            (el) =>
              el.role === "AXTextArea" ||
              el.role === "AXTextField" ||
              el.role === "textField" ||
              el.role === "textArea",
          );
          if (inputField) {
            await peekaboo.click(
              APP_NAME,
              managerWindow.window_id,
              inputField.id,
              mgSnapshot.snapshot_id,
            );
          }
          // Include workspace path context in the prompt
          const contextPrefix = `You are working in ${config.workspacePath}. `;
          await peekaboo.paste(APP_NAME, contextPrefix + config.launchCommand);

          // Click Send button (more reliable than Return)
          const sendBtn = findSendButton(mgSnapshot.ui_elements);
          if (sendBtn) {
            await peekaboo.click(
              APP_NAME,
              managerWindow.window_id,
              sendBtn.id,
              mgSnapshot.snapshot_id,
            );
          } else {
            // Fallback to Return if Send button not found
            await peekaboo.press(APP_NAME, "Return");
          }
        }

        return conversationWindow.title;
      };

      const result = await executeWithFallback(
        primaryFn,
        config.launchCommand ?? "start session",
        config.workspacePath,
        fallbackCfg,
      );

      // When peekaboo succeeds, build session from the actual window state.
      // When fallback was used, create a synthetic session.
      let session: AntigravitySession;
      if (!result.fallbackUsed) {
        // Re-fetch window state to populate session fields
        const postWindows = await peekaboo.windowList(APP_NAME);
        const managerWindow = postWindows.find((w) =>
          w.title.toLowerCase().includes("manager"),
        );
        const wsBase = workspaceBasename(config.workspacePath).toLowerCase();
        let conversationWindow = postWindows.find(
          (w) => w.title.toLowerCase().includes(wsBase),
        );
        if (!conversationWindow) {
          conversationWindow = postWindows.find(
            (w) =>
              !w.title.toLowerCase().includes("manager") &&
              !w.title.toLowerCase().includes("launchpad") &&
              !w.title.toLowerCase().includes("hidden"),
          );
        }
        session = {
          conversationTitle:
            conversationWindow?.title ?? result.output,
          workspaceName: config.workspacePath,
          windowId: conversationWindow?.window_id ?? -1,
          managerWindowId: managerWindow?.window_id ?? -1,
          status: "running",
          createdAt: Date.now(),
          lastCheckedAt: Date.now(),
        };
      } else {
        if (!result.success) {
          throw new Error(
            `Failed to create Antigravity session: both peekaboo and CLI fallback failed`,
          );
        }
        session = {
          conversationTitle: `CLI fallback: ${config.workspacePath}`,
          workspaceName: config.workspacePath,
          windowId: -1,
          managerWindowId: -1,
          status: "running",
          createdAt: Date.now(),
          lastCheckedAt: Date.now(),
          fallbackPid: result.pid,
        };
      }

      const handle: RuntimeHandle = {
        id: config.sessionId,
        runtimeName: "antigravity",
        data: {
          createdAt: session.createdAt,
          workspacePath: config.workspacePath,
          session,
          fallbackUsed: result.fallbackUsed,
          ...(config.onIdle && { onIdle: config.onIdle }),
        },
      };

      // Start idle detection polling against the Manager window.
      // Only poll when there's a real onIdle subscriber — avoids wasteful
      // peekaboo.see() calls when no callback is registered.
      if (config.onIdle) {
        poller.start(handle, session.managerWindowId);
      }

      return handle;
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      // One-shot guard — prevent double-destroy from calling SIGTERM on a
      // recycled PID. (CodeRabbit #a493466b)
      if (handle.data["destroyed"] === true) return;
      handle.data["destroyed"] = true;

      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) return;

      try {
        // Kill fallback CLI process if present — capture and clear PID first so
        // a second destroy() call is a no-op even if the PID was recycled.
        if (session.fallbackPid) {
          const fallbackPid = session.fallbackPid;
          session.fallbackPid = undefined;
          try {
            process.kill(fallbackPid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }

        // For Peekaboo sessions, close the conversation window.
        // Uses window-scoped see+click to avoid targeting wrong window
        // in multi-window scenarios (paste/press are app-scoped).
        if (session.windowId !== -1) {
          const windows = await peekaboo.windowList(APP_NAME);
          const conversationWindow = windows.find(
            (w) => w.window_id === session.windowId,
          );
          if (conversationWindow) {
            const snapshot = await peekaboo.see(
              APP_NAME,
              session.windowId,
            );
            if (snapshot.ui_elements.length > 0) {
              await peekaboo.click(
                APP_NAME,
                session.windowId,
                snapshot.ui_elements[0].id,
                snapshot.snapshot_id,
              );
            }
            await peekaboo.hotkey(APP_NAME, "cmd+w");
          }
        }
      } catch {
        // Best-effort cleanup — window may already be closed
      } finally {
        // Always mark session idle, even if cleanup threw
        session.status = "idle";
      }

      // Stop idle detection polling for this session.
      poller.stop(handle.id);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) {
        throw new Error("No session data in handle — was create() called?");
      }

      const primaryFn = async (): Promise<string> => {
        // Use the Manager window for input — conversations are managed
        // through the Agent Manager, not individual editor windows.
        const targetWindowId =
          session.managerWindowId !== -1
            ? session.managerWindowId
            : session.windowId;

        // 1. Take a snapshot to find the text input field
        const snapshot = await peekaboo.see(APP_NAME, targetWindowId);
        const inputField = snapshot.ui_elements.find(
          (el) =>
            el.role === "AXTextArea" ||
            el.role === "AXTextField" ||
            el.role === "textField" ||
            el.role === "textArea",
        );

        if (inputField) {
          // Click the text field to focus it
          await peekaboo.click(
            APP_NAME,
            targetWindowId,
            inputField.id,
            snapshot.snapshot_id,
          );
        }

        // 2. Paste the message
        await peekaboo.paste(APP_NAME, message);

        // 3. Click Send button (more reliable than Return)
        const sendBtn = findSendButton(snapshot.ui_elements);
        if (sendBtn) {
          await peekaboo.click(
            APP_NAME,
            targetWindowId,
            sendBtn.id,
            snapshot.snapshot_id,
          );
        } else {
          await peekaboo.press(APP_NAME, "Return");
        }
        return "sent";
      };

      const fallbackCfg: Partial<FallbackConfig> = {
        cliBin: runtimeConfig.fallbackCliBin,
        cliFlags: runtimeConfig.fallbackCliFlags,
        maxRetries: runtimeConfig.fallbackMaxRetries,
      };

      const result = await executeWithFallback(
        primaryFn,
        message,
        String(handle.data["workspacePath"] ?? "."),
        fallbackCfg,
      );

      if (!result.success) {
        throw new Error(
          `Failed to send message: both Peekaboo and CLI fallback failed`,
        );
      }
      if (result.fallbackUsed) {
        handle.data["fallbackUsed"] = true;
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) return "";

      // For fallback sessions, no window to snapshot
      if (session.windowId === -1) return "";

      try {
        // Read from Manager window when available (has conversation content),
        // falling back to conversation window.
        const targetWindowId =
          session.managerWindowId !== -1
            ? session.managerWindowId
            : session.windowId;
        // Read-only snapshot — do NOT wrap in executeWithFallback because
        // conversation content may contain text that matches error patterns
        // (e.g. "element not found"), causing false fallback invocations.
        const snapshot = await peekaboo.see(APP_NAME, targetWindowId);
        const textContent = snapshot.ui_elements
          .filter((el) => el.label || el.title)
          .map((el) => el.label || el.title)
          .join("\n");

        // Return last N lines
        const allLines = textContent.split("\n");
        return allLines.slice(-lines).join("\n");
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) return false;

      // Fallback sessions (windowId === -1): check if CLI process is still alive
      if (session.windowId === -1) {
        if (session.status !== "running") return false;
        if (session.fallbackPid) {
          try {
            // Signal 0 checks if process exists without killing it
            process.kill(session.fallbackPid, 0);
            return true;
          } catch {
            session.status = "idle";
            return false;
          }
        }
        return false;
      }

      try {
        const windows = await peekaboo.windowList(APP_NAME);
        return windows.some((w) => w.window_id === session.windowId);
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      let target: string;
      if (!session) {
        target = `${APP_NAME} (unknown window)`;
      } else if (session.windowId === -1) {
        target = `${APP_NAME} CLI fallback: ${session.workspaceName}`;
      } else {
        target = `${APP_NAME} window ${session.windowId}: ${session.conversationTitle}`;
      }
      return {
        type: session?.windowId === -1 ? "process" : "web",
        target,
      };
    },
  };
}
