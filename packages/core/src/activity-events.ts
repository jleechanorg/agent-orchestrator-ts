/**
 * Activity event logging — write API.
 *
 * recordActivityEvent() is synchronous and best-effort: it never throws.
 * If the DB is unavailable or a write fails, the event is dropped and
 * droppedEventCount is incremented.
 *
 * droppedEventCount is process-local. Events dropped in other processes
 * (web server, lifecycle manager) are not reflected here.
 */

import { getDb } from "./events-db.js";

export type ActivityEventSource =
  | "lifecycle"
  | "session-manager"
  | "api"
  | "ui"
  | "scm"
  | "runtime"
  | "agent"
  | "tracker"
  | "workspace"
  | "notifier"
  | "reaction"
  | "report-watcher"
  | "cli"
  | "config"
  | "plugin-registry"
  | "migration"
  | "recovery";

export type ActivityEventKind =
  // Session lifecycle
  | "session.spawn_started"
  | "session.spawned"
  | "session.spawn_failed"
  | "session.spawn_step_failed"
  | "session.killed"
  | "session.kill_started"
  | "session.send_failed"
  | "session.restore_failed"
  | "session.restore_fallback"
  | "session.rollback_started"
  | "session.rollback_step_failed"
  | "session.workspace_hooks_failed"
  | "session.cleanup_error"
  | "session.orchestrator_conflict"
  | "session.auto_cleanup_deferred"
  | "session.auto_cleanup_completed"
  | "session.auto_cleanup_failed"
  // Runtime/agent
  | "runtime.lost_detected"
  | "runtime.lost_persist_failed"
  | "runtime.probe_failed"
  | "runtime.destroy_failed"
  | "agent.process_probe_failed"
  | "agent.activity_probe_failed"
  | "agent.opencode_purge_failed"
  // Workspace
  | "workspace.destroy_failed"
  | "workspace.post_create_failed"
  | "workspace.branch_collision"
  | "workspace.destroy_fell_back"
  | "workspace.corrupt_clone_skipped"
  // Tracker
  | "tracker.issue_fetch_failed"
  | "tracker.generate_prompt_failed"
  | "tracker.dep_missing"
  | "tracker.api_timeout"
  // Notifier
  | "notifier.auth_failed"
  | "notifier.unreachable"
  | "notifier.rate_limited"
  | "notifier.dep_missing"
  // Activity/lifecycle transitions
  | "activity.transition"
  | "lifecycle.transition"
  | "lifecycle.poll_failed"
  | "detecting.escalated"
  // CI/review
  | "ci.failing"
  | "review.pending"
  // SCM
  | "scm.gh_unavailable"
  | "scm.batch_enrich_failed"
  | "scm.batch_enrich_pr_failed"
  | "scm.ci_summary_failclosed"
  | "scm.detect_pr_succeeded"
  | "scm.detect_pr_failed"
  | "scm.review_fetch_failed"
  | "scm.poll_pr_failed"
  // Reaction
  | "reaction.escalated"
  | "reaction.send_to_agent_failed"
  | "reaction.action_succeeded"
  // Report watcher
  | "report_watcher.triggered"
  // Config/plugin-registry/storage migration
  | "config.project_resolve_failed"
  | "config.project_malformed"
  | "config.project_invalid"
  | "config.migrated"
  | "plugin-registry.load_failed"
  | "plugin-registry.validation_failed"
  | "plugin-registry.specifier_failed"
  | "migration.blocked"
  | "migration.project_failed"
  | "migration.rename_failed"
  | "migration.completed"
  | "migration.rollback_skipped"
  // Webhook ingress (api source)
  | "api.webhook_unverified"
  | "api.webhook_rejected"
  | "api.webhook_received"
  | "api.webhook_failed"
  // WebSocket terminal mux (ui source)
  | "ui.terminal_connected"
  | "ui.terminal_disconnected"
  | "ui.terminal_heartbeat_lost"
  | "ui.terminal_pty_lost"
  | "ui.terminal_protocol_error"
  | "ui.session_broadcast_failed"
  // Recovery/forensic instrumentation
  | "recovery.session_failed"
  | "recovery.action_failed"
  | "metadata.corrupt_detected"
  | "api.agent_report.session_not_found"
  | "api.agent_report.transition_rejected"
  | "api.agent_report.apply_failed";

export type ActivityEventLevel = "debug" | "info" | "warn" | "error";

export interface ActivityEventInput {
  projectId?: string;
  sessionId?: string;
  source: ActivityEventSource | string;
  kind: ActivityEventKind | string;
  level?: ActivityEventLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface ActivityEvent {
  id: number;
  tsEpoch: number;
  ts: string;
  projectId: string | null;
  sessionId: string | null;
  source: string;
  kind: string;
  level: string;
  summary: string;
  data: string | null;
  rank?: number;
}

let _droppedEventCount = 0;
let _lastPruneMs = 0;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 1000;

export function droppedEventCount(): number {
  return _droppedEventCount;
}

function pruneOldEvents(db: ReturnType<typeof getDb>, cutoff: number): void {
  db?.prepare(
    `DELETE FROM activity_events
       WHERE rowid IN (
         SELECT rowid FROM activity_events WHERE ts_epoch < ? LIMIT ?
       )`,
  ).run(cutoff, PRUNE_BATCH_SIZE);
}

// Patterns that indicate sensitive field names
const SENSITIVE_KEY_RE = /token|password|secret|authorization|cookie|api[-_]?key/i;

// Linear scan for credential URL redaction — replaces the previous regex-based
// CREDENTIAL_URL_RE which was either ReDoS-prone (unbounded quantifier) or
// missed >200-char userinfo (bounded quantifier). O(n) worst case, no regex
// backtracking, no length limits.
function redactCredentialUrls(input: string): string {
  let result = input;
  let offset = 0;
  while (offset < result.length) {
    const proto = result.indexOf("://", offset);
    if (proto === -1) break;
    if (proto < 4) {
      offset = proto + 3;
      continue;
    }
    const schemeEnd = result.slice(Math.max(0, proto - 5), proto).toLowerCase();
    if (!schemeEnd.endsWith("http") && !schemeEnd.endsWith("https")) {
      offset = proto + 3;
      continue;
    }

    let cursor = proto + 3;
    while (cursor < result.length) {
      const ch = result.charCodeAt(cursor);
      if (ch <= 0x20 || ch === 0x2f) break;
      if (ch === 0x40) {
        const before = result.slice(0, proto + 3).toLowerCase();
        const suffix = result.slice(cursor);
        result = before + "[redacted]" + suffix;
        offset = proto + 3 + "[redacted]".length + 1;
        break;
      }
      cursor++;
    }
    if (
      cursor >= result.length ||
      result.charCodeAt(cursor) <= 0x20 ||
      result.charCodeAt(cursor) === 0x2f
    ) {
      offset = proto + 3;
    }
  }
  return result;
}

const STRING_VALUE_MAX_CHARS = 500;

// Token-shape patterns matched against ANY string value, not just keys.
// These redact token-shaped substrings anywhere — including under keys like
// `message` and `errorMessage`, which are FTS5-indexed.
const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  [/\bsk-(?:ant-)?(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]"],
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|API_KEY|APIKEY)[A-Z0-9_]*)=([^\s"'`]{6,})/g,
    "$1=[redacted]",
  ],
];

function sanitizeString(value: string): string {
  let cleaned = redactCredentialUrls(value);
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  if (cleaned.length > STRING_VALUE_MAX_CHARS) {
    cleaned = `${cleaned.slice(0, STRING_VALUE_MAX_CHARS - 3)}...`;
  }
  return cleaned;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    cleaned[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : sanitizeValue(v, seen);
  }
  return cleaned;
}

function sanitizeData(data: Record<string, unknown>): string | undefined {
  const cleaned = sanitizeValue(data, new WeakSet<object>());

  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return undefined;
  }

  if (json.length > 16 * 1024) {
    return undefined;
  }
  return json;
}

function sanitizeSummary(summary: string): string {
  if (summary.length <= 500) return summary;
  return `${summary.slice(0, 497)}...`;
}

export function recordActivityEvent(event: ActivityEventInput): void {
  try {
    const db = getDb();
    if (!db) {
      _droppedEventCount++;
      return;
    }

    const now = Date.now();
    const ts = new Date(now).toISOString();
    const summary = sanitizeSummary(event.summary);
    const data = event.data ? sanitizeData(event.data) : undefined;

    db.prepare(
      `INSERT INTO activity_events
        (ts_epoch, ts, project_id, session_id, source, type, log_level, summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now,
      ts,
      event.projectId ?? null,
      event.sessionId ?? null,
      event.source,
      event.kind,
      event.level ?? "info",
      summary,
      data ?? null,
    );
    if (now - _lastPruneMs >= PRUNE_INTERVAL_MS) {
      _lastPruneMs = now;
      pruneOldEvents(db, now - RETENTION_MS);
    }
  } catch {
    _droppedEventCount++;
  }
}
