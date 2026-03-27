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
import type { AntigravitySession, PeekabooUIElement, PeekabooSeeResult } from "./types.js";
import { defaultConfig, type AntigravityConfig } from "./config.js";

/** Application name for Peekaboo targeting. */
const APP_NAME = "Antigravity";

/**
 * Check whether a UI element's text matches a workspace path.
 *
 * The Antigravity Manager sidebar shows only the directory basename
 * (e.g. "worldai_claw"), never the full absolute path. This helper
 * tries: direct substring, basename, and parent directory name.
 */
export function matchesWorkspace(elementText: string, workspacePath: string): boolean {
  const lower = elementText.toLowerCase();
  const pathLower = workspacePath.toLowerCase();
  // Direct match (handles rare case where full path is shown)
  if (lower.includes(pathLower)) return true;
  // Basename match (e.g., "worldai_claw" from "/Users/.../worldai_claw")
  const basename = pathLower.split("/").filter(Boolean).pop() ?? "";
  if (basename && lower.includes(basename)) return true;
  // Parent dir match (e.g., "project_worldaiclaw")
  const parts = pathLower.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (lower.includes(parent)) return true;
  }
  return false;
}

/**
 * Find a workspace element in a list of UI elements by matching
 * title or label against the workspace path.
 */
function findWorkspace(
  elements: PeekabooUIElement[],
  workspacePath: string,
): PeekabooUIElement | undefined {
  return elements.find(
    (el) =>
      matchesWorkspace(el.title, workspacePath) ||
      matchesWorkspace(el.label, workspacePath),
  );
}

/**
 * After pasting a message, find and click the Send button.
 * Falls back to pressing Return if no Send button is found.
 */
async function clickSendButton(windowId: number, snapshotForSend?: PeekabooSeeResult): Promise<void> {
  const snap = snapshotForSend ?? await peekaboo.see(APP_NAME, windowId);
  const sendButton = snap.ui_elements.find(
    (el) => el.label === "Send" || el.title === "Send",
  );
  if (sendButton) {
    await peekaboo.click(APP_NAME, windowId, sendButton.id, snap.snapshot_id);
  } else {
    // Fallback: press Return (may add newline in some contexts)
    await peekaboo.press(APP_NAME, "Return");
  }
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

        // 2. Take snapshot of Manager window, find workspace to click.
        //    Uses basename matching (Bug 1) and scroll retry (Bug 2).
        let snapshot = await peekaboo.see(APP_NAME, managerWindow.window_id);
        let workspaceElement = findWorkspace(snapshot.ui_elements, config.workspacePath);

        // If workspace not visible, scroll down and retry up to 5 times
        if (!workspaceElement) {
          for (let i = 0; i < 5 && !workspaceElement; i++) {
            await peekaboo.scroll(APP_NAME, managerWindow.window_id, "down", 5);
            await new Promise((r) => setTimeout(r, 500));
            const newSnapshot = await peekaboo.see(APP_NAME, managerWindow.window_id);
            workspaceElement = findWorkspace(newSnapshot.ui_elements, config.workspacePath);
            if (workspaceElement) {
              snapshot = newSnapshot; // Update snapshot for click
            }
          }
        }

        if (!workspaceElement) {
          throw new Error(
            `Workspace "${config.workspacePath}" not found in Antigravity Manager`,
          );
        }

        // 3. Click the workspace to open/focus it
        await peekaboo.click(
          APP_NAME,
          managerWindow.window_id,
          workspaceElement.id,
          snapshot.snapshot_id,
        );

        // 4. Find the conversation window that opens.
        //    Match workspace basename in window title instead of picking
        //    the first non-Manager window (Bug 3).
        const postClickWindows = await peekaboo.windowList(APP_NAME);
        const wsBasename = config.workspacePath.split("/").filter(Boolean).pop() ?? "";
        const conversationWindow = postClickWindows.find(
          (w) =>
            w.window_id !== managerWindow.window_id &&
            w.title.toLowerCase().includes(wsBasename.toLowerCase()),
        ) ?? postClickWindows.find(
          // Fallback: any non-Manager window if basename match fails
          (w) =>
            w.window_id !== managerWindow.window_id &&
            !w.title.toLowerCase().includes("manager"),
        );
        if (!conversationWindow) {
          throw new Error(
            "Conversation window did not open after clicking workspace",
          );
        }

        // 5. Send the initial prompt if provided via launchCommand.
        //    Click Send button instead of pressing Return (Bug 4).
        if (config.launchCommand) {
          await peekaboo.paste(APP_NAME, config.launchCommand);
          await clickSendButton(conversationWindow.window_id);
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
        const conversationWindow = postWindows.find(
          (w) => !w.title.toLowerCase().includes("manager"),
        );
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
        // Use managerWindowId for Manager-based sessions (Bug 5),
        // fall back to editor windowId for direct sessions.
        const targetWindow =
          session.managerWindowId !== -1
            ? session.managerWindowId
            : session.windowId;

        // 1. Take a snapshot to find the text input field
        const snapshot = await peekaboo.see(APP_NAME, targetWindow);
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
            targetWindow,
            inputField.id,
            snapshot.snapshot_id,
          );
        }

        // 2. Paste the message and click Send button (Bug 4)
        await peekaboo.paste(APP_NAME, message);
        await clickSendButton(targetWindow);
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
        // Read-only snapshot — do NOT wrap in executeWithFallback because
        // conversation content may contain text that matches error patterns
        // (e.g. "element not found"), causing false fallback invocations.
        const snapshot = await peekaboo.see(APP_NAME, session.windowId);
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
