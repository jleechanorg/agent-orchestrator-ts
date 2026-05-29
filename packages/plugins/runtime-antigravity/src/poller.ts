/**
 * Idle Poller for Antigravity conversations (bd-5kp.6).
 *
 * Polls conversation status via peekaboo.see() on the Manager window
 * and fires callbacks when status transitions are detected.
 *
 * Status is inferred from UI element labels:
 *   - "progress_activity" → Running
 *   - Time-ago suffix (e.g. "5m", "1h") → Idle
 *   - "capacity" text → Capacity-wait
 */

import type { RuntimeHandle } from "@jleechanorg/ao-core";
import * as peekaboo from "./peekaboo.js";
import type { AntigravitySession, PeekabooUIElement } from "./types.js";

// =============================================================================
// Public Types
// =============================================================================

export interface PollerCallbacks {
  onIdle: (handle: RuntimeHandle) => void;
  onCapacityWait: (handle: RuntimeHandle, retryAfterMs: number) => void;
}

export interface Poller {
  start(handle: RuntimeHandle, managerWindowId: number): void;
  stop(handleId: string): void;
  stopAll(): void;
}

// =============================================================================
// Detected states
// =============================================================================

type DetectedState = "running" | "idle" | "capacity-wait" | "unknown";

/** Default retry delay for capacity-wait (ms). */
const CAPACITY_RETRY_MS = 30_000;

// =============================================================================
// Detection heuristics
// =============================================================================

/** Detect status from a UI element's visible label. */
function detectStateFromLabel(label: string): DetectedState {
  const lower = label.toLowerCase();

  if (lower.includes("progress_activity")) {
    return "running";
  }

  if (lower.includes("capacity")) {
    return "capacity-wait";
  }

  // Time-ago suffix: e.g. "5m ago", "1h ago", "30s ago", "2d ago"
  if (/\d+[smhd]\s*(ago)?/i.test(label)) {
    return "idle";
  }

  return "unknown";
}

interface ConversationDetection {
  state: DetectedState;
  /** True when the state came from a conversation-row that matched conversationTitle.
   *  False when it came from the fallback scan (any element). onIdle must only fire
   *  when this is true — the fallback scan cannot confirm which session is idle. */
  conversationFound: boolean;
}

/**
 * Determine conversation status from the Manager window snapshot.
 *
 * Scans ui_elements for one whose title matches the conversation title,
 * then inspects labels (title + value) for status indicators.
 */
function detectConversationState(
  conversationTitle: string,
  elements: readonly PeekabooUIElement[],
): ConversationDetection {
  // First, try to find an element that references this conversation.
  // The Manager window shows conversation titles with status info.
  for (const el of elements) {
    const matchesConversation =
      el.title.includes(conversationTitle) ||
      el.label.includes(conversationTitle);

    if (matchesConversation) {
      const fromTitle = detectStateFromLabel(el.title);
      if (fromTitle !== "unknown") return { state: fromTitle, conversationFound: true };

      const fromValue = detectStateFromLabel(el.label);
      if (fromValue !== "unknown") return { state: fromValue, conversationFound: true };
    }
  }

  // Fallback: scan all elements for status indicators.
  // conversationFound is false — we can't confirm which conversation matched.
  for (const el of elements) {
    const fromTitle = detectStateFromLabel(el.title);
    if (fromTitle !== "unknown") return { state: fromTitle, conversationFound: false };

    const fromValue = detectStateFromLabel(el.label);
    if (fromValue !== "unknown") return { state: fromValue, conversationFound: false };
  }

  return { state: "unknown", conversationFound: false };
}

// =============================================================================
// Factory
// =============================================================================

interface PollerEntry {
  timerId: ReturnType<typeof setInterval>;
  lastState: DetectedState;
  inFlight: boolean; // Prevents overlapping peekaboo.see() calls
}

/**
 * Create an idle-detection poller.
 *
 * @param intervalMs - How often to check (recommended: 15_000)
 * @param callbacks  - Handlers for state transitions
 */
export function createPoller(
  intervalMs: number,
  callbacks: PollerCallbacks,
): Poller {
  const entries = new Map<string, PollerEntry>();

  function pollTick(handle: RuntimeHandle, managerWindowId: number): void {
    const entry = entries.get(handle.id);
    if (!entry || entry.inFlight) return;
    entry.inFlight = true;

    const session = handle.data["session"] as AntigravitySession | undefined;
    const conversationTitle = session?.conversationTitle ?? "";

    peekaboo
      .see("Antigravity", managerWindowId)
      .then((result) => {
        const currentEntry = entries.get(handle.id);
        if (!currentEntry) return; // stopped while awaiting
        // Always clear inFlight, even on early returns
        currentEntry.inFlight = false;

        const { state, conversationFound } = detectConversationState(
          conversationTitle,
          result.ui_elements,
        );

        if (state === "unknown") return;

        const previousState = currentEntry.lastState;

        // Transition: running → idle OR capacity-wait → idle, but ONLY when a
        // conversation-specific row was matched (conversationFound). Without a
        // specific row match, the fallback scan could pick up an unrelated idle
        // conversation in the Manager window. (bd-5o2)
        if (conversationFound && (previousState === "running" || previousState === "capacity-wait") && state === "idle") {
          try {
            callbacks.onIdle(handle);
          } catch {
            // Callback failed — do NOT update lastState; next poll will retry.
            return;
          }
        }

        // Capacity-wait detection (fire every tick while in this state)
        if (state === "capacity-wait") {
          try {
            callbacks.onCapacityWait(handle, CAPACITY_RETRY_MS);
          } catch {
            // Callback failed — skip state update so next poll retries.
            return;
          }
        }

        // Only update lastState after callbacks succeed — prevents lost
        // transitions when onIdle/onCapacityWait throws (Cursor BugBot #e4679aca).
        currentEntry.lastState = state;
      })
      .catch(() => {
        const currentEntry = entries.get(handle.id);
        if (currentEntry) currentEntry.inFlight = false;
      });
  }

  return {
    start(handle: RuntimeHandle, managerWindowId: number): void {
      // Skip polling for fallback sessions (CLI-only, no GUI window to observe).
      if (managerWindowId === -1) return;
      // Prevent duplicate pollers for the same handle
      if (entries.has(handle.id)) return;

      const entry: PollerEntry = {
        timerId: setInterval(
          () => pollTick(handle, managerWindowId),
          intervalMs,
        ),
        lastState: "unknown",
        inFlight: false,
      };
      entries.set(handle.id, entry);
    },

    stop(handleId: string): void {
      const entry = entries.get(handleId);
      if (entry) {
        clearInterval(entry.timerId);
        entries.delete(handleId);
      }
    },

    stopAll(): void {
      for (const entry of entries.values()) {
        clearInterval(entry.timerId);
      }
      entries.clear();
    },
  };
}
