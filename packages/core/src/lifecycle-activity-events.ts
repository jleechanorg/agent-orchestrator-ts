/**
 * Companion module: activity event hooks for lifecycle-manager.
 *
 * Extracted from upstream's inline changes to lifecycle-manager.ts to minimize
 * the fork diff surface. The lifecycle-manager imports these hooks and calls
 * them at the appropriate points — one-line additions per call site.
 */

import { recordActivityEvent } from "./activity-events.js";
import type { ActivityState } from "./types.js";

export function emitLifecycleTransition(
  projectId: string,
  sessionId: string,
  from: string,
  to: string,
): void {
  recordActivityEvent({
    projectId,
    sessionId,
    source: "lifecycle",
    kind: "lifecycle.transition",
    level: to === "ci_failed" ? "warn" : "info",
    summary: `${from} → ${to}`,
    data: { from, to },
  });
}

export function emitActivityTransition(
  projectId: string,
  sessionId: string,
  from: ActivityState,
  to: ActivityState,
): void {
  recordActivityEvent({
    projectId,
    sessionId,
    source: "lifecycle",
    kind: "activity.transition",
    level: "info",
    summary: `${from} → ${to}`,
    data: { from, to },
  });
}
