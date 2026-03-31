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
import { CdpClient } from "./cdp-client.js";

/** Application name for Peekaboo targeting. */
const APP_NAME = "Antigravity";

/** Max retries when looking for the "Start new conversation" button. */
const NEW_CONV_BUTTON_RETRIES = 5;

/** Max retries when verifying conversation started (progress_activity). */
const VERIFY_START_RETRIES = 5;

/** Delay between retries (ms). */
const RETRY_DELAY_MS = 1000;

/**
 * Find the "add Start new conversation" button in UI elements.
 *
 * Matches only buttons that START WITH "add" — avoids matching
 * text that merely mentions "new conversation" (e.g. conversation
 * titles that happen to contain those words).
 *
 * Per the Manager UI element map in the /antig skill.
 */
function findNewConversationButton(
  elements: PeekabooUIElement[],
): PeekabooUIElement | undefined {
  return elements.find((el) => {
    const role = el.role?.toLowerCase() ?? "";
    const isButtonRole =
      role === "axbutton" || role === "button" || role === "axmenuitem";
    const label = el.label?.toLowerCase() ?? "";
    const title = el.title?.toLowerCase() ?? "";
    const startsWithAdd = label.startsWith("add ") || title.startsWith("add ");
    return (
      isButtonRole &&
      startsWithAdd &&
      (label.includes("new conversation") || title.includes("new conversation"))
    );
  });
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
  const capturePath = `/tmp/antig_allow_check_${Date.now()}.png`;

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

    // Detect pixel scale factor: screencapture captures at native resolution,
    // so on 2x Retina displays the pixel count is 2x the point count.
    // Use the ratio of captured image width to window point width to
    // derive the scale factor automatically, avoiding hard-coded "// 2".
    const winX = Math.round(bounds.x);
    const winY = Math.round(bounds.y);
    const winW = Math.round(bounds.width);
    const pythonScript = `
from PIL import Image
import numpy as np
img = np.array(Image.open('${capturePath}'))
# Derive scale factor from image width vs window width to support non-Retina displays.
scale = img.shape[1] / ${winW} if ${winW} > 0 else 2
blue_mask = (img[:,:,2] > 150) & (img[:,:,0] < 120) & (img[:,:,2] > img[:,:,1] + 30)
ys, xs = np.where(blue_mask)
if len(xs) > 0:
    right_mask = xs > (xs.max() - 250)
    cx, cy = int(np.mean(xs[right_mask])), int(np.mean(ys[right_mask]))
    # Convert pixel coords to points using dynamic scale factor, add window origin
    print(f'{${winX} + int(cx / scale)},{${winY} + int(cy / scale)}')
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
  } finally {
    // Clean up temporary screenshot file to avoid leaving stale files.
    const { unlink } = await import("node:fs/promises");
    unlink(capturePath).catch(() => {
      // Ignore if file was never created (screencapture failed early)
    });
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
      let cdpClient: CdpClient | undefined;
      try {
        // Attempt CDP connection first
        cdpClient = await CdpClient.connect();
      } catch {
        // Fallback to peekaboo if CDP is not available
      }

      const fallbackCfg: Partial<FallbackConfig> = {
        cliBin: runtimeConfig.fallbackCliBin,
        cliFlags: runtimeConfig.fallbackCliFlags,
        maxRetries: runtimeConfig.fallbackMaxRetries,
      };

      // Capture managerId from primaryFn so post-executeWithFallback code
      // doesn't need a redundant window re-lookup that can fail.
      let capturedManagerId = -1;

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
        capturedManagerId = managerId; // Capture for use after executeWithFallback

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
          
          if (cdpClient && cdpClient.isConnected()) {
            await cdpClient.evaluateInAntigravity(`
              (() => {
                const el = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
                if (!el) throw new Error('CDP create: input element not found');
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                  el.value = ${JSON.stringify(fullPrompt)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                  el.innerText = ${JSON.stringify(fullPrompt)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const sendBtn = document.querySelector('button[aria-label*="Send" i], button[type="submit"]');
                if (!sendBtn) throw new Error('CDP create: send button not found');
                sendBtn.click();
              })()
            `);
          } else {
            await peekaboo.paste(APP_NAME, fullPrompt);

            // 6. Press Return to send (NOT click Send button)
            //    Per /antig skill: "In active conversations, the Send button
            //    does NOT appear in A11y. Use peekaboo press Return instead."
            await peekaboo.press(APP_NAME, "Return");
          }
        }

        // 7. Handle "Allow this conversation" directory access prompt FIRST.
        //    Per /antig skill: the Allow prompt appears BEFORE the agent starts
        //    working. If we wait for progress_activity first, the prompt blocks
        //    the conversation from starting at all.
        //    Blue buttons are web-rendered (not A11y tree) — use screencapture
        //    + PIL blue-pixel detection + coordinate click.
        if (config.launchCommand) {
          try {
            await handleAllowPrompt(managerId, managerWindow.bounds);
          } catch {
            // Best-effort — prompt may not appear or PIL may not be installed
          }
        }

        // 8. Verify conversation started: check for progress_activity.
        //    Only verify if a prompt was actually submitted.
        if (config.launchCommand) {
          let started = false;
          for (let i = 0; i < VERIFY_START_RETRIES && !started; i++) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            const verifySnapshot = await peekaboo.see(APP_NAME, managerId);
            if (hasProgressActivity(verifySnapshot.ui_elements)) {
              started = true;
            }
          }
          if (!started) {
            throw new Error(
              "Antigravity: conversation did not start — no progress_activity detected after prompt submission",
            );
          }
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
      // Use capturedManagerId (set in primaryFn) to avoid a redundant window
      // re-lookup that could fail and set windowId to -1.
      let session: AntigravitySession;
      if (!result.fallbackUsed) {
        session = {
          conversationTitle: result.output,
          workspaceName: config.workspacePath,
          windowId: capturedManagerId,
          managerWindowId: capturedManagerId,
          status: "running",
          createdAt: Date.now(),
          lastCheckedAt: Date.now(),
        };
      } else {
        if (!result.success) {
          cdpClient?.disconnect();
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
          cdpClient, // Store active CDP client for other methods
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

        // Disconnect CDP client to close the WebSocket and free resources.
        const cdp = handle.data["cdpClient"] as CdpClient | undefined;
        if (cdp?.isConnected()) {
          cdp.disconnect();
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

      const cdpClient = handle.data["cdpClient"] as CdpClient | undefined;

      const primaryFn = async (): Promise<string> => {
        if (cdpClient && cdpClient.isConnected()) {
          // Use CDP to send message directly to DOM.
          // Throws if input element or send button is not found,
          // so executeWithFallback can route to peekaboo fallback.
          await cdpClient.evaluateInAntigravity(`
            (() => {
              const el = document.querySelector('textarea, [contenteditable="true"], input[type="text"]');
              if (!el) throw new Error('CDP sendMessage: input element not found');
              if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                el.value = ${JSON.stringify(message)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                el.innerText = ${JSON.stringify(message)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const sendBtn = document.querySelector('button[aria-label*="Send" i], button[type="submit"]');
              if (!sendBtn) throw new Error('CDP sendMessage: send button not found');
              sendBtn.click();
            })()
          `);
          return "sent";
        }

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

      const cdpClient = handle.data["cdpClient"] as CdpClient | undefined;

      try {
        if (cdpClient && cdpClient.isConnected()) {
          const textContent = await cdpClient.getConversationText();
          const allLines = textContent.split("\n");
          return allLines.slice(-lines).join("\n");
        }

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
