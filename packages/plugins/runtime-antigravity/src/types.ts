/**
 * Types for the Antigravity runtime plugin.
 *
 * Covers Antigravity session state, plugin configuration,
 * and typed representations of Peekaboo CLI output.
 */

// =============================================================================
// Antigravity Session & Config
// =============================================================================

/** Status of an Antigravity conversation session. */
export type AntigravitySessionStatus =
  | "running"
  | "idle"
  | "capacity-wait"
  | "failed";

/** Tracks a single Antigravity conversation managed by this runtime. */
export interface AntigravitySession {
  /** Title of the Antigravity conversation (used for identification). */
  conversationTitle: string;
  /** Workspace name / path opened in Antigravity. */
  workspaceName: string;
  /** Peekaboo window ID for the conversation window. */
  windowId: number;
  /** Peekaboo window ID for the Antigravity Manager window. */
  managerWindowId: number;
  /** Current observed status. */
  status: AntigravitySessionStatus;
  /** Epoch ms when session was created. */
  createdAt: number;
  /** Epoch ms when session was last checked via peekaboo. */
  lastCheckedAt: number;
  /** PID of fallback CLI process, if fallback was used. */
  fallbackPid?: number;
}

// NOTE: AntigravityConfig is now defined via Zod schema in config.ts.


// =============================================================================
// Peekaboo CLI Output Types
// =============================================================================

/** A window entry returned by `peekaboo list`. */
export interface PeekabooWindow {
  window_id: number;
  title: string;
  app: string;
  bounds: { x: number; y: number; width: number; height: number };
}

/** A UI element returned by `peekaboo see`. */
export interface PeekabooUIElement {
  id: string;
  role: string;
  title: string;
  value: string;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Result of `peekaboo see` — a visual snapshot of a window. */
export interface PeekabooSeeResult {
  snapshot_id: string;
  ui_elements: PeekabooUIElement[];
}

/** Result of `peekaboo click`. */
export interface PeekabooClickResult {
  success: boolean;
}
