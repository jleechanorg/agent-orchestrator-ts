/**
 * Preflight checks for Antigravity runtime.
 *
 * Runs a sequence of readiness probes before attempting to create a
 * session via Peekaboo, so callers can fall back to CLI gracefully
 * rather than hitting opaque accessibility errors mid-session.
 *
 * TTL is enforced via AbortController + setTimeout so callers never
 * hang indefinitely on a broken accessibility subsystem.
 */

import * as peekaboo from "./peekaboo.js";

/** Application name for Peekaboo targeting. */
const APP_NAME = "Antigravity";

/**
 * Outcome of a single preflight step.
 */
export interface PreflightStep {
  name: string;
  passed: boolean;
  error?: string;
}

/**
 * Overall preflight result.
 */
export interface PreflightResult {
  /** True only when all steps passed. */
  ok: boolean;
  /** Steps executed in order; first failure stops the run. */
  steps: PreflightStep[];
  /** Milliseconds elapsed across all steps. */
  elapsedMs: number;
}

/**
 * Configuration for runPreflight.
 */
export interface PreflightConfig {
  /**
   * Maximum time to spend on all preflight checks (ms).
   * Defaults to 10 000 ms.
   */
  timeoutMs?: number;
}

/**
 * Run preflight checks for the Antigravity runtime.
 *
 * Checks performed (in order, first failure stops):
 *   1. Peekaboo binary is reachable
 *   2. Antigravity app is running (windowList returns non-empty)
 *   3. Manager window is present
 *
 * @param config - Optional timeout override.
 * @returns PreflightResult with ok=false on any failure.
 */
export async function runPreflight(
  config: PreflightConfig = {},
): Promise<PreflightResult> {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const steps: PreflightStep[] = [];
  const start = Date.now();

  try {
    // Step 1 — Peekaboo reachable: windowList throws if CLI is missing.
    try {
      await peekaboo.windowList(APP_NAME);
      steps.push({ name: "peekaboo-reachable", passed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ name: "peekaboo-reachable", passed: false, error: msg });
      return { ok: false, steps, elapsedMs: Date.now() - start };
    }

    // Step 2 — Antigravity app is running.
    try {
      const windows = await peekaboo.windowList(APP_NAME);
      if (windows.length === 0) {
        steps.push({
          name: "app-running",
          passed: false,
          error: "No Antigravity windows found — is the app running?",
        });
        return { ok: false, steps, elapsedMs: Date.now() - start };
      }
      steps.push({ name: "app-running", passed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ name: "app-running", passed: false, error: msg });
      return { ok: false, steps, elapsedMs: Date.now() - start };
    }

    // Step 3 — Manager window is present.
    try {
      const windows = await peekaboo.windowList(APP_NAME);
      const managerWindow = windows.find((w) =>
        w.title.toLowerCase().includes("manager"),
      );
      if (!managerWindow) {
        steps.push({
          name: "manager-window",
          passed: false,
          error: "Antigravity Manager window not found — open Antigravity first",
        });
        return { ok: false, steps, elapsedMs: Date.now() - start };
      }
      steps.push({ name: "manager-window", passed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({ name: "manager-window", passed: false, error: msg });
      return { ok: false, steps, elapsedMs: Date.now() - start };
    }

    return { ok: true, steps, elapsedMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
