/**
 * AO Action Log — local audit trail for PR mutations.
 *
 * Every PR mutation (close, merge, comment, dismiss) is appended to
 * /tmp/ao-actions.jsonl so /auton can attribute actions to AO vs human.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_PATH = "/tmp/ao-actions.jsonl";

export interface AoAction {
  ts?: string;
  session: string;
  action: "pr_close" | "pr_merge" | "pr_comment" | "review_dismiss" | "session_kill";
  pr?: number;
  repo?: string;
  reason?: string;
  detail?: string;
}

export function logAoAction(action: AoAction): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const line = JSON.stringify({ ...action, ts: action.ts || new Date().toISOString() }) + "\n";
    appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch {
    // Best-effort — never crash lifecycle-worker for logging
  }
}

