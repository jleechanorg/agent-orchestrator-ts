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
import { executeWithFallback } from "./fallback.js";
import type { AntigravitySession } from "./types.js";
import type { FallbackConfig } from "./fallback.js";

/** Application name for Peekaboo targeting. */
const APP_NAME = "Antigravity";

/**
 * Create an AntigravityRuntime instance.
 *
 * Follows the same factory pattern as the tmux runtime.
 */
export function createAntigravityRuntime(): Runtime {
  return {
    name: "antigravity",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      const fallbackCfg = config.environment["FALLBACK_CONFIG"] as
        | Partial<FallbackConfig>
        | undefined;

      const primaryFn = async (): Promise<string> => {
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

        // 2. Take snapshot of Manager window, find workspace to click
        const snapshot = await peekaboo.see(APP_NAME, managerWindow.window_id);
        const workspaceElement = snapshot.ui_elements.find(
          (el) =>
            el.title.toLowerCase().includes(config.workspacePath.toLowerCase()) ||
            el.value.toLowerCase().includes(config.workspacePath.toLowerCase()),
        );
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

        // 4. Find the conversation window that opens
        const postClickWindows = await peekaboo.windowList(APP_NAME);
        const conversationWindow = postClickWindows.find(
          (w) =>
            w.window_id !== managerWindow.window_id &&
            !w.title.toLowerCase().includes("manager"),
        );
        if (!conversationWindow) {
          throw new Error(
            "Conversation window did not open after clicking workspace",
          );
        }

        // 5. Send the initial prompt if provided via launchCommand
        if (config.launchCommand) {
          await peekaboo.paste(APP_NAME, config.launchCommand);
          await peekaboo.press(APP_NAME, "Return");
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
        session = {
          conversationTitle: `CLI fallback: ${config.workspacePath}`,
          workspaceName: config.workspacePath,
          windowId: -1,
          managerWindowId: -1,
          status: result.success ? "running" : "failed",
          createdAt: Date.now(),
          lastCheckedAt: Date.now(),
        };
      }

      return {
        id: config.sessionId,
        runtimeName: "antigravity",
        data: {
          createdAt: session.createdAt,
          workspacePath: config.workspacePath,
          session,
          fallbackUsed: result.fallbackUsed,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        const session = handle.data["session"] as
          | AntigravitySession
          | undefined;
        if (!session) return;

        // Best-effort: try to close the conversation window
        // by focusing it and sending Cmd+W or similar
        const windows = await peekaboo.windowList(APP_NAME);
        const conversationWindow = windows.find(
          (w) => w.window_id === session.windowId,
        );
        if (conversationWindow) {
          // Press Cmd+W to close the window
          await peekaboo.press(APP_NAME, "Command+w");
        }
      } catch {
        // Best-effort cleanup — window may already be closed
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) {
        throw new Error("No session data in handle — was create() called?");
      }

      const primaryFn = async (): Promise<string> => {
        // 1. Take a snapshot to find the text input field
        const snapshot = await peekaboo.see(APP_NAME, session.windowId);
        const inputField = snapshot.ui_elements.find(
          (el) =>
            el.role === "AXTextArea" ||
            el.role === "AXTextField" ||
            el.role === "textField",
        );

        if (inputField) {
          // Click the text field to focus it
          await peekaboo.click(
            APP_NAME,
            session.windowId,
            inputField.id,
            snapshot.snapshot_id,
          );
        }

        // 2. Paste the message and press Enter to send
        await peekaboo.paste(APP_NAME, message);
        await peekaboo.press(APP_NAME, "Return");
        return "sent";
      };

      const result = await executeWithFallback(
        primaryFn,
        message,
        String(handle.data["workspacePath"] ?? "."),
      );

      if (result.fallbackUsed) {
        handle.data["fallbackUsed"] = true;
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) return "";

      const primaryFn = async (): Promise<string> => {
        // Take a snapshot and extract visible text content
        const snapshot = await peekaboo.see(APP_NAME, session.windowId);
        const textContent = snapshot.ui_elements
          .filter((el) => el.value || el.title)
          .map((el) => el.value || el.title)
          .join("\n");

        // Return last N lines
        const allLines = textContent.split("\n");
        return allLines.slice(-lines).join("\n");
      };

      try {
        const result = await executeWithFallback(
          primaryFn,
          "get current output",
          String(handle.data["workspacePath"] ?? "."),
        );

        if (result.fallbackUsed) {
          handle.data["fallbackUsed"] = true;
        }

        return result.output;
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) return false;

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
      const target = session
        ? `${APP_NAME} window ${session.windowId}: ${session.conversationTitle}`
        : `${APP_NAME} (unknown window)`;
      return {
        type: "web",
        target,
      };
    },
  };
}
