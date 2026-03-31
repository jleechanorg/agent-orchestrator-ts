/**
 * Antigravity Runtime — implements the ao-core Runtime interface.
 *
 * Drives the Antigravity IDE via Peekaboo macOS accessibility API
 * to create conversations, send messages, and capture output.
 *
 * Flow aligned with proven /antig skill patterns (SKILL.md):
 * - Uses "add Start new conversation" button (not workspace labels)
 * - Conversations live INSIDE Manager window (not separate windows)
 * - Uses paste + Return to send (not Send button in active convos)
 * - Handles "Allow this conversation" via screencapture + blue-pixel detection
 * - Includes workspace path in prompt text for workspace scoping
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
import type { AntigravitySession, PeekabooUIElement } from "./types.js";
import { defaultConfig, type AntigravityConfig } from "./config.js";

/** Application name for Peekaboo targeting. */
const APP_NAME = "Antigravity";

/** Max retries when looking for the "Start new conversation" button. */
const NEW_CONV_BUTTON_RETRIES = 5;

/** Max retries when verifying conversation started (progress_activity). */
const VERIFY_START_RETRIES = 5;

/** Delay between retries (ms). */
const RETRY_DELAY_MS = 1000;

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
 * Find the "Start new conversation" button in UI elements.
 *
 * Matches labels: "add Start new conversation" or "add New Conversation"
 * per the Manager UI element map in the /antig skill.
 */
function findNewConversationButton(
  elements: PeekabooUIElement[],
): PeekabooUIElement | undefined {
  return elements.find(
    (el) =>
      el.label?.toLowerCase().includes("start new conversation") ||
      el.label?.toLowerCase().includes("new conversation") ||
      el.title?.toLowerCase().includes("start new conversation") ||
      el.title?.toLowerCase().includes("new conversation"),
  );
}

/**
 * Find the text input field in Manager window.
 *
 * Per /antig skill: role=textField, label="text entry area"
 */
function findTextField(
  elements: PeekabooUIElement[],
): PeekabooUIElement | undefined {
  return elements.find(
    (el) =>
      (el.role === "textField" || el.role === "AXTextField") &&
      (el.label?.includes("text entry") ?? false),
  );
}

/**
 * Check if conversation has started by looking for progress_activity.
 *
 * Per /antig skill: after sending, check for "progress_activity" in A11y elements.
 */
function hasProgressActivity(elements: PeekabooUIElement[]): boolean {
  return elements.some(
    (el) =>
      el.label?.includes("progress_activity") ||
      el.title?.includes("progress_activity"),
  );
}

/**
 * Detect and dismiss "Allow this conversation" directory access prompt.
 *
 * Uses screencapture + python3 PIL blue-pixel detection, matching
 * the exact pattern from /antig skill Method 0/1.
 *
 * The Allow/Deny buttons are web-rendered and NOT in the A11y tree.
 * Detection: capture Manager window → find blue pixels (R<120, B>150, B>G+30)
 * → click the rightmost blue button cluster (= "Allow This Conversation").
 *
 * @param windowId - Manager window ID
 * @param bounds - Window bounds {x, y, width, height} in screen points
 */
async function handleAllowPrompt(
  windowId: number,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const capturePath = "/tmp/antig_allow_check.png";

  try {
    // Step 1: Capture the Manager window region
    await peekaboo.screencapture(
      bounds.x, bounds.y, bounds.width, bounds.height,
      capturePath,
    );

    // Step 2: Use python3 + PIL to detect blue button coordinates
    // Directly translates /antig skill Method 0 pattern:
    //   blue_mask = (B > 150) & (R < 120) & (B > G + 30)
    //   Find rightmost cluster → "Allow This Conversation"
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);

    const pythonScript = `
from PIL import Image
import numpy as np
img = np.array(Image.open('${capturePath}'))
blue_mask = (img[:,:,2] > 150) & (img[:,:,0] < 120) & (img[:,:,2] > img[:,:,1] + 30)
ys, xs = np.where(blue_mask)
if len(xs) > 0:
    right_mask = xs > (xs.max() - 250)
    cx, cy = int(np.mean(xs[right_mask])), int(np.mean(ys[right_mask]))
    # Convert 2x retina pixels to points, add window origin
    print(f'{${bounds.x} + cx // 2},{${bounds.y} + cy // 2}')
`;

    const { stdout } = await execFileAsync("python3", ["-c", pythonScript], {
      timeout: 10_000,
    });

    const coords = stdout.trim();
    if (coords && coords.includes(",")) {
      const [clickX, clickY] = coords.split(",").map(Number);
      if (!isNaN(clickX) && !isNaN(clickY)) {
        await peekaboo.clickCoordinates(APP_NAME, windowId, clickX, clickY);
        // Brief delay for UI to dismiss the prompt
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch {
    // Best-effort: if screencapture or python3 fails, continue anyway.
    // The Allow prompt may not be present, or PIL may not be installed.
  }
}

/**
 * Build the prompt text with workspace path prefix.
 *
 * Per /antig skill "Workspace scoping workaround — CRITICAL":
 * The workspace dropdown is web-rendered and unreliable.
 * Always include the explicit workspace path in the prompt text.
 */
function buildPromptWithWorkspace(prompt: string, workspacePath: string): string {
  return `You are working in ${workspacePath}. ${prompt}`;
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
  peekaboo.setPeekabooBin(runtimeConfig.peekabooBin);

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
        const managerId = managerWindow.window_id;

        // 2. Scroll sidebar UP to reveal "Start new conversation" button
        //    Per /antig skill: button may be hidden below sidebar fold
        await peekaboo.scroll(APP_NAME, managerId, "up", 10);
        await new Promise((r) => setTimeout(r, 300));

        // 3. Find and click "Start new conversation" button
        let snapshot = await peekaboo.see(APP_NAME, managerId);
        let newConvButton = findNewConversationButton(snapshot.ui_elements);

        // Retry with more scrolling if not found
        if (!newConvButton) {
          for (let i = 0; i < NEW_CONV_BUTTON_RETRIES && !newConvButton; i++) {
            await peekaboo.scroll(APP_NAME, managerId, "up", 5);
            await new Promise((r) => setTimeout(r, 500));
            snapshot = await peekaboo.see(APP_NAME, managerId);
            newConvButton = findNewConversationButton(snapshot.ui_elements);
          }
        }

        if (!newConvButton) {
          throw new Error(
            "'Start new conversation' button not found in Manager sidebar after scrolling",
          );
        }

        await peekaboo.click(APP_NAME, managerId, newConvButton.id, snapshot.snapshot_id);
        await new Promise((r) => setTimeout(r, 500));

        // 4. In new conversation view: find text field, click it, paste prompt
        //    Per /antig skill: role=textField, label="text entry area"
        const convSnapshot = await peekaboo.see(APP_NAME, managerId);
        const textField = findTextField(convSnapshot.ui_elements);

        if (textField) {
          await peekaboo.click(APP_NAME, managerId, textField.id, convSnapshot.snapshot_id);
        }

        // 5. Paste prompt with workspace path prefix
        if (config.launchCommand) {
          const fullPrompt = buildPromptWithWorkspace(config.launchCommand, config.workspacePath);
          await peekaboo.paste(APP_NAME, fullPrompt);

          // 6. Press Return to send (NOT click Send button)
          //    Per /antig skill: "In active conversations, the Send button
          //    does NOT appear in A11y. Use peekaboo press Return instead."
          await peekaboo.press(APP_NAME, "Return");
        }

        // 7. Verify conversation started: check for progress_activity
        let started = false;
        for (let i = 0; i < VERIFY_START_RETRIES && !started; i++) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          const verifySnapshot = await peekaboo.see(APP_NAME, managerId);
          if (hasProgressActivity(verifySnapshot.ui_elements)) {
            started = true;
          }
        }

        // 8. Handle "Allow this conversation" directory access prompt
        //    Per /antig skill: blue buttons are web-rendered, use
        //    screencapture + PIL blue-pixel detection + coordinate click
        try {
          await handleAllowPrompt(managerId, managerWindow.bounds);
        } catch {
          // Best-effort — prompt may not appear
        }

        return managerWindow.title;
      };

      const result = await executeWithFallback(
        primaryFn,
        config.launchCommand ?? "start session",
        config.workspacePath,
        fallbackCfg,
      );

      // Build session — conversations live INSIDE Manager, not separate windows
      let session: AntigravitySession;
      if (!result.fallbackUsed) {
        const postWindows = await peekaboo.windowList(APP_NAME);
        const managerWindow = postWindows.find((w) =>
          w.title.toLowerCase().includes("manager"),
        );
        // Session windowId = managerWindowId (conversations are inside Manager)
        session = {
          conversationTitle: result.output,
          workspaceName: config.workspacePath,
          windowId: managerWindow?.window_id ?? -1,
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

      if (config.onIdle) {
        poller.start(handle, session.managerWindowId);
      }

      return handle;
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      // One-shot guard — prevent double-destroy
      if (handle.data["destroyed"] === true) return;
      handle.data["destroyed"] = true;

      const session = handle.data["session"] as
        | AntigravitySession
        | undefined;
      if (!session) return;

      try {
        // Kill fallback CLI process if present
        if (session.fallbackPid) {
          const fallbackPid = session.fallbackPid;
          session.fallbackPid = undefined;
          try {
            process.kill(fallbackPid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }

        // For Peekaboo sessions: conversations persist in Manager,
        // no 'close window' action needed. Just mark as idle.
        // Per /antig skill: conversations live inside Manager window.
      } catch {
        // Best-effort cleanup
      } finally {
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
        // Always target Manager window — conversations live inside it
        const targetWindow = session.managerWindowId;

        // 1. Take a snapshot to find the text input field
        //    Per /antig skill: role=textField, label="text entry area"
        const snapshot = await peekaboo.see(APP_NAME, targetWindow);
        const textField = findTextField(snapshot.ui_elements);

        if (textField) {
          // Click the text field to focus it
          await peekaboo.click(
            APP_NAME,
            targetWindow,
            textField.id,
            snapshot.snapshot_id,
          );
        }

        // 2. Paste the message and press Return
        //    Per /antig skill: "In active/idle conversations, the Send
        //    button does NOT appear in A11y. Use peekaboo press Return."
        await peekaboo.paste(APP_NAME, message);
        await peekaboo.press(APP_NAME, "Return");
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
        // Use Manager window for output capture
        // Per /antig skill: conversation content is web-rendered,
        // A11y only gives sidebar buttons. But we capture what we can.
        const snapshot = await peekaboo.see(APP_NAME, session.managerWindowId);
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

      // Fallback sessions: check if CLI process is still alive
      if (session.windowId === -1) {
        if (session.status !== "running") return false;
        if (session.fallbackPid) {
          try {
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
        // Check if Manager window still exists
        const windows = await peekaboo.windowList(APP_NAME);
        return windows.some((w) => w.window_id === session.managerWindowId);
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
