/**
 * Session metadata read/write — dual format support.
 *
 * JSON format (V2 — primary):
 * - Session metadata: ~/.agent-orchestrator/projects/{projectId}/sessions/{sessionId}.json
 * - Status: computed on read from lifecycle via deriveLegacyStatus().
 * - Pre-lifecycle sessions retain a stored status field.
 *
 * Flat key=value format (legacy — kept for bash script compatibility):
 * - Path: ~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionName}
 * - Format: key=value pairs (one per line), compatible with bash scripts
 *
 * Archive: flat-format sessions can be archived on delete (legacy behavior preserved).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  renameSync,
  statSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { join, dirname } from "node:path";
import type { CanonicalSessionLifecycle, RuntimeHandle, SessionId, SessionMetadata, PRState } from "./types.js";
import { VALID_PR_STATES } from "./types.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { parseKeyValueContent } from "./key-value.js";
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  deriveLegacyStatus,
  parseCanonicalLifecycle,
} from "./lifecycle-state.js";
import { assertValidSessionIdComponent, SESSION_ID_COMPONENT_PATTERN } from "./utils/session-id.js";
import { flattenToStringRecord } from "./utils/metadata-flatten.js";
import { validateStatus } from "./utils/validation.js";
import { withFileLockSync } from "./file-lock.js";

const JSON_EXTENSION = ".json";

// =============================================================================
// JSON SERIALIZATION (V2 — primary format)
// =============================================================================

function serializeMetadataJson(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2) + "\n";
}

function parseMetadataContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseLifecycleField(raw: Record<string, unknown>): CanonicalSessionLifecycle | undefined {
  if (raw["lifecycle"] && typeof raw["lifecycle"] === "object") {
    return raw["lifecycle"] as CanonicalSessionLifecycle;
  }
  if (raw["statePayload"] && raw["stateVersion"] === "2") {
    if (typeof raw["statePayload"] === "object") {
      return raw["statePayload"] as CanonicalSessionLifecycle;
    }
    if (typeof raw["statePayload"] === "string") {
      try {
        return JSON.parse(raw["statePayload"]) as CanonicalSessionLifecycle;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function parseRuntimeHandleField(value: unknown): RuntimeHandle | undefined {
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj["id"] === "string" && typeof obj["runtimeName"] === "string") {
      return value as RuntimeHandle;
    }
    return undefined;
  }
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (typeof parsed["id"] === "string" && typeof parsed["runtimeName"] === "string") {
        return parsed as unknown as RuntimeHandle;
      }
    } catch { /* not valid JSON */ }
  }
  return undefined;
}

function parseDashboardField(raw: Record<string, unknown>): SessionMetadata["dashboard"] {
  if (typeof raw["dashboard"] === "object" && raw["dashboard"] !== null) {
    const d = raw["dashboard"] as Record<string, unknown>;
    return {
      port: typeof d["port"] === "number" ? d["port"] : undefined,
      terminalWsPort: typeof d["terminalWsPort"] === "number" ? d["terminalWsPort"] : undefined,
      directTerminalWsPort: typeof d["directTerminalWsPort"] === "number" ? d["directTerminalWsPort"] : undefined,
    };
  }
  const port = typeof raw["dashboardPort"] === "number" ? raw["dashboardPort"] : undefined;
  const terminalWsPort = typeof raw["terminalWsPort"] === "number" ? raw["terminalWsPort"] : undefined;
  const directTerminalWsPort = typeof raw["directTerminalWsPort"] === "number" ? raw["directTerminalWsPort"] : undefined;
  if (port !== undefined || terminalWsPort !== undefined || directTerminalWsPort !== undefined) {
    return { port, terminalWsPort, directTerminalWsPort };
  }
  return undefined;
}

// =============================================================================
// FLAT SERIALIZATION (legacy — bash compatible)
// =============================================================================

function serializeMetadataFlat(data: Record<string, string>): string {
  return (
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v.replace(/[\r\n]/g, " ")}`)
      .join("\n") + "\n"
  );
}

// =============================================================================
// VALIDATION
// =============================================================================

const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: SessionId): void {
  assertValidSessionIdComponent(sessionId);
}

// =============================================================================
// PATH HELPERS
// =============================================================================

function metadataPathJson(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, `${sessionId}${JSON_EXTENSION}`);
}

function metadataPathFlat(dataDir: string, sessionId: SessionId): string {
  validateSessionId(sessionId);
  return join(dataDir, sessionId);
}

/** Detect whether a session uses JSON or flat format by checking for .json file first. */
function detectFormat(dataDir: string, sessionId: SessionId): "json" | "flat" | null {
  const jsonPath = metadataPathJson(dataDir, sessionId);
  if (existsSync(jsonPath)) return "json";
  const flatPath = metadataPathFlat(dataDir, sessionId);
  if (existsSync(flatPath)) return "flat";
  return null;
}

// =============================================================================
// JSON READ/WRITE (V2 — primary)
// =============================================================================

export function readMetadata(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = metadataPathJson(dataDir, sessionId);

  let content: string;
  try {
    content = readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
  if (!content) return null;
  const raw = parseMetadataContent(content);
  if (!raw) return null;

  const lifecycle = parseLifecycleField(raw);
  const storedStatus = raw["status"] as string | undefined;
  const status = lifecycle ? deriveLegacyStatus(lifecycle) : (storedStatus ?? "unknown");

  return {
    worktree: (raw["worktree"] as string) ?? "",
    branch: (raw["branch"] as string) ?? "",
    status,
    tmuxName: raw["tmuxName"] as string | undefined,
    issue: raw["issue"] as string | undefined,
    issueTitle: raw["issueTitle"] as string | undefined,
    pr: raw["pr"] as string | undefined,
    prAutoDetect:
      raw["prAutoDetect"] === "off" || raw["prAutoDetect"] === "false" || raw["prAutoDetect"] === false ? false :
      raw["prAutoDetect"] === "on" || raw["prAutoDetect"] === "true" || raw["prAutoDetect"] === true ? true : undefined,
    summary: raw["summary"] as string | undefined,
    project: raw["project"] as string | undefined,
    agent: raw["agent"] as string | undefined,
    createdAt: raw["createdAt"] as string | undefined,
    runtimeHandle: parseRuntimeHandleField(raw["runtimeHandle"]),
    lifecycle,
    restoredAt: raw["restoredAt"] as string | undefined,
    role: raw["role"] as string | undefined,
    dashboard: parseDashboardField(raw),
    opencodeSessionId: raw["opencodeSessionId"] as string | undefined,
    pinnedSummary: raw["pinnedSummary"] as string | undefined,
    userPrompt: raw["userPrompt"] as string | undefined,
    displayName: raw["displayName"] as string | undefined,
    displayNameUserSet:
      raw["displayNameUserSet"] === "off" ||
      raw["displayNameUserSet"] === "false" ||
      raw["displayNameUserSet"] === false
        ? false
        : raw["displayNameUserSet"] === "on" ||
            raw["displayNameUserSet"] === "true" ||
            raw["displayNameUserSet"] === true
          ? true
          : undefined,
  };
}

export function readMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  const format = detectFormat(dataDir, sessionId);

  if (format === "flat") {
    return readMetadataRawFlat(dataDir, sessionId);
  }

  const path = metadataPathJson(dataDir, sessionId);

  let content: string;
  try {
    content = readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
  if (!content) return null;
  const raw = parseMetadataContent(content);
  if (!raw) return null;

  if (raw["lifecycle"] || (raw["statePayload"] && raw["stateVersion"] === "2")) {
    const lifecycle = parseLifecycleField(raw);
    if (lifecycle) {
      raw["status"] = deriveLegacyStatus(lifecycle);
    }
  }
  return flattenToStringRecord(raw);
}

export function writeMetadata(
  dataDir: string,
  sessionId: SessionId,
  metadata: SessionMetadata,
): void {
  const path = metadataPathJson(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });

  const data: Record<string, unknown> = {
    worktree: metadata.worktree,
    branch: metadata.branch,
    ...(metadata.lifecycle ? {} : { status: metadata.status }),
  };

  if (metadata.tmuxName) data["tmuxName"] = metadata.tmuxName;
  if (metadata.issue) data["issue"] = metadata.issue;
  if (metadata.issueTitle) data["issueTitle"] = metadata.issueTitle;
  if (metadata.pr) data["pr"] = metadata.pr;
  if (metadata.prAutoDetect !== undefined) data["prAutoDetect"] = metadata.prAutoDetect;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.agent) data["agent"] = metadata.agent;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = metadata.runtimeHandle;
  if (metadata.lifecycle) data["lifecycle"] = metadata.lifecycle;
  if (metadata.restoredAt) data["restoredAt"] = metadata.restoredAt;
  if (metadata.role) data["role"] = metadata.role;
  if (metadata.dashboard) data["dashboard"] = metadata.dashboard;
  if (metadata.opencodeSessionId) data["opencodeSessionId"] = metadata.opencodeSessionId;
  if (metadata.pinnedSummary) data["pinnedSummary"] = metadata.pinnedSummary;
  if (metadata.userPrompt) data["userPrompt"] = metadata.userPrompt;
  if (metadata.displayName) data["displayName"] = metadata.displayName;
  if (metadata.displayNameUserSet !== undefined)
    data["displayNameUserSet"] = metadata.displayNameUserSet;

  atomicWriteFileSync(path, serializeMetadataJson(data));

  removeFlatFormatIfPresent(dataDir, sessionId);
}

// =============================================================================
// FLAT READ/WRITE (legacy — bash compatible)
// =============================================================================

export function readMetadataFlat(dataDir: string, sessionId: SessionId): SessionMetadata | null {
  const path = metadataPathFlat(dataDir, sessionId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  const raw = parseKeyValueContent(content);

  return {
    worktree: raw["worktree"] ?? "",
    branch: raw["branch"] ?? "",
    status: raw["status"] ?? "unknown",
    tmuxName: raw["tmuxName"],
    issue: raw["issue"],
    pr: raw["pr"],
    prState: VALID_PR_STATES.has(raw["prState"] as PRState)
      ? (raw["prState"] as PRState)
      : undefined,
    prAutoDetect:
      raw["prAutoDetect"] === "off" ? "off" : raw["prAutoDetect"] === "on" ? "on" : undefined,
    summary: raw["summary"],
    project: raw["project"],
    agent: raw["agent"],
    action: raw["action"],
    createdAt: raw["createdAt"],
    runtimeHandle: raw["runtimeHandle"],
    restoredAt: raw["restoredAt"],
    role: raw["role"],
    dashboardPort: raw["dashboardPort"] ? Number(raw["dashboardPort"]) : undefined,
    terminalWsPort: raw["terminalWsPort"] ? Number(raw["terminalWsPort"]) : undefined,
    directTerminalWsPort: raw["directTerminalWsPort"]
      ? Number(raw["directTerminalWsPort"])
      : undefined,
    opencodeSessionId: raw["opencodeSessionId"],
    pinnedSummary: raw["pinnedSummary"],
    userPrompt: raw["userPrompt"],
    requestedTask: raw["requestedTask"],
    composedPromptPath: raw["composedPromptPath"],
    repoPath: raw["repoPath"],
    displayName: raw["displayName"],
    displayNameUserSet:
      raw["displayNameUserSet"] === "true" || raw["displayNameUserSet"] === "on"
        ? true
        : raw["displayNameUserSet"] === "false" || raw["displayNameUserSet"] === "off"
          ? false
          : undefined,
  };
}

export function readMetadataRawFlat(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  const path = metadataPathFlat(dataDir, sessionId);
  if (!existsSync(path)) return null;
  return parseKeyValueContent(readFileSync(path, "utf-8"));
}

export function writeMetadataFlat(
  dataDir: string,
  sessionId: SessionId,
  metadata: SessionMetadata,
): void {
  const path = metadataPathFlat(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });

  const data: Record<string, string> = {
    worktree: metadata.worktree,
    branch: metadata.branch,
    status: metadata.status,
  };

  if (metadata.tmuxName) data["tmuxName"] = metadata.tmuxName;
  if (metadata.issue) data["issue"] = metadata.issue;
  if (metadata.pr) data["pr"] = metadata.pr;
  if (metadata.prState) data["prState"] = metadata.prState;
  if (metadata.prAutoDetect !== undefined) data["prAutoDetect"] = typeof metadata.prAutoDetect === "boolean" ? (metadata.prAutoDetect ? "on" : "off") : metadata.prAutoDetect;
  if (metadata.summary) data["summary"] = metadata.summary;
  if (metadata.project) data["project"] = metadata.project;
  if (metadata.agent) data["agent"] = metadata.agent;
  if (metadata.action) data["action"] = metadata.action;
  if (metadata.createdAt) data["createdAt"] = metadata.createdAt;
  if (metadata.runtimeHandle) data["runtimeHandle"] = typeof metadata.runtimeHandle === "string" ? metadata.runtimeHandle : JSON.stringify(metadata.runtimeHandle);
  if (metadata.restoredAt) data["restoredAt"] = metadata.restoredAt;
  if (metadata.role) data["role"] = metadata.role;
  if (metadata.dashboardPort !== undefined) data["dashboardPort"] = String(metadata.dashboardPort);
  if (metadata.terminalWsPort !== undefined)
    data["terminalWsPort"] = String(metadata.terminalWsPort);
  if (metadata.directTerminalWsPort !== undefined)
    data["directTerminalWsPort"] = String(metadata.directTerminalWsPort);
  if (metadata.opencodeSessionId) data["opencodeSessionId"] = metadata.opencodeSessionId;
  if (metadata.repoPath) data["repoPath"] = metadata.repoPath;
  if (metadata.pinnedSummary) data["pinnedSummary"] = metadata.pinnedSummary;
  if (metadata.userPrompt) data["userPrompt"] = metadata.userPrompt;
  if (metadata.requestedTask) data["requestedTask"] = metadata.requestedTask;
  if (metadata.composedPromptPath) data["composedPromptPath"] = metadata.composedPromptPath;
  if (metadata.displayName) data["displayName"] = metadata.displayName;
  if (metadata.displayNameUserSet !== undefined) {
    data["displayNameUserSet"] = typeof metadata.displayNameUserSet === "boolean"
      ? String(metadata.displayNameUserSet)
      : metadata.displayNameUserSet;
  }

  atomicWriteFileSync(path, serializeMetadataFlat(data));
}

// =============================================================================
// UPDATE / MUTATE (format-aware)
// =============================================================================

export function updateMetadata(
  dataDir: string,
  sessionId: SessionId,
  updates: Partial<Record<string, string>>,
): void {
  const format = detectFormat(dataDir, sessionId);

  if (format === "flat") {
    updateMetadataFlat(dataDir, sessionId, updates);
    return;
  }

  mutateMetadata(dataDir, sessionId, (existing) => {
    return applyMetadataUpdates(existing, updates);
  }, { createIfMissing: true });
}

export function applyMetadataUpdates(
  existing: Record<string, string>,
  updates: Partial<Record<string, string>>,
): Record<string, string> {
  let next = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _removed, ...rest } = next;
      void _removed;
      next = rest;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function normalizeMetadataRecord(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && value !== ""),
  );
}

const jsonFields = new Set([
  "runtimeHandle", "lifecycle", "statePayload", "dashboard",
  "agentReport", "reportWatcher",
]);

function unflattenFromStringRecord(data: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const numberFields = new Set(["dashboardPort", "terminalWsPort", "directTerminalWsPort"]);
  const booleanFields = new Set(["prAutoDetect", "displayNameUserSet"]);

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === "") continue;
    if (booleanFields.has(key)) {
      result[key] = value === "on" || value === "true" ? true : value === "off" || value === "false" ? false : value;
    } else if (numberFields.has(key)) {
      const num = Number(value);
      result[key] = Number.isFinite(num) ? num : value;
    } else if (jsonFields.has(key) && (value.startsWith("{") || value.startsWith("["))) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function mutateMetadata(
  dataDir: string,
  sessionId: SessionId,
  updater: (existing: Record<string, string>) => Record<string, string>,
  options: { createIfMissing?: boolean } = {},
): Record<string, string> | null {
  const path = metadataPathJson(dataDir, sessionId);
  const lockPath = `${path}.lock`;

  return withFileLockSync(lockPath, () => {
    let existing: Record<string, string> = {};

    let content: string | undefined;
    try {
      content = readFileSync(path, "utf-8").trim();
    } catch {
      // File doesn't exist
    }

    if (content !== undefined) {
      if (content) {
        const raw = parseMetadataContent(content);
        if (raw) {
          existing = flattenToStringRecord(raw);
        } else {
          const corruptPath = `${path}.corrupt-${Date.now()}`;
          try {
            renameSync(path, corruptPath);
          } catch {
            // best effort
          }
        }
      }
    } else if (!options.createIfMissing) {
      return null;
    }

    const next = normalizeMetadataRecord(updater({ ...existing }));

    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, serializeMetadataJson(unflattenFromStringRecord(next)));
    return next;
  }, { timeoutMs: 5_000, staleMs: 30_000 });
}

function updateMetadataFlat(
  dataDir: string,
  sessionId: SessionId,
  updates: Partial<Record<string, string>>,
): void {
  const path = metadataPathFlat(dataDir, sessionId);
  let existing: Record<string, string> = {};

  if (existsSync(path)) {
    existing = parseKeyValueContent(readFileSync(path, "utf-8"));
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _, ...rest } = existing;
      existing = rest;
    } else {
      existing[key] = value;
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, serializeMetadataFlat(existing));
}

// =============================================================================
// LIFECYCLE HELPERS (V2)
// =============================================================================

export function readCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
): CanonicalSessionLifecycle | null {
  const raw = readMetadataRaw(dataDir, sessionId);
  if (!raw) return null;
  return parseCanonicalLifecycle(raw, { sessionId, status: validateStatus(raw["status"]) });
}

export function writeCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
  lifecycle: CanonicalSessionLifecycle,
): void {
  updateMetadata(
    dataDir,
    sessionId,
    buildLifecycleMetadataPatch(cloneLifecycle(lifecycle)),
  );
}

export function updateCanonicalLifecycle(
  dataDir: string,
  sessionId: SessionId,
  updater: (current: CanonicalSessionLifecycle) => CanonicalSessionLifecycle,
): CanonicalSessionLifecycle | null {
  const raw = readMetadataRaw(dataDir, sessionId);
  if (!raw) return null;
  const current = parseCanonicalLifecycle(raw, {
    sessionId,
    status: validateStatus(raw["status"]),
  });
  const next = updater(cloneLifecycle(current));
  writeCanonicalLifecycle(dataDir, sessionId, next);
  return next;
}

// =============================================================================
// DELETE (with archive support for legacy flat sessions)
// =============================================================================

export function deleteMetadata(dataDir: string, sessionId: SessionId, archive = false): void {
  const jsonPath = metadataPathJson(dataDir, sessionId);
  const flatPath = metadataPathFlat(dataDir, sessionId);

  if (archive) {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (existsSync(flatPath)) {
      const archivePath = join(archiveDir, `${sessionId}_${timestamp}`);
      writeFileSync(archivePath, readFileSync(flatPath, "utf-8"));
    }

    if (existsSync(jsonPath)) {
      const archivePath = join(archiveDir, `${sessionId}_${timestamp}.json`);
      writeFileSync(archivePath, readFileSync(jsonPath, "utf-8"));
    }
  }

  if (existsSync(flatPath)) {
    try { unlinkSync(flatPath); } catch { /* concurrent delete */ }
  }
  if (existsSync(jsonPath)) {
    try { unlinkSync(jsonPath); } catch { /* concurrent delete */ }
  }
}

// =============================================================================
// ARCHIVE READ/WRITE (legacy flat-format archives)
// =============================================================================

export function readArchivedMetadataRaw(
  dataDir: string,
  sessionId: SessionId,
): Record<string, string> | null {
  validateSessionId(sessionId);
  const archiveDir = join(dataDir, "archive");
  if (!existsSync(archiveDir)) return null;

  const prefix = `${sessionId}_`;
  let latest: string | null = null;

  for (const file of readdirSync(archiveDir)) {
    if (!file.startsWith(prefix)) continue;
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    if (!latest || file > latest) {
      latest = file;
    }
  }

  if (!latest) return null;
  try {
    const content = readFileSync(join(archiveDir, latest), "utf-8");
    if (latest.endsWith(JSON_EXTENSION)) {
      const raw = parseMetadataContent(content);
      if (raw) return flattenToStringRecord(raw);
      return null;
    }
    return parseKeyValueContent(content);
  } catch {
    return null;
  }
}

export function updateArchivedMetadata(
  dataDir: string,
  sessionId: SessionId,
  updates: Partial<Record<string, string>>,
): boolean {
  validateSessionId(sessionId);
  const archiveDir = join(dataDir, "archive");
  if (!existsSync(archiveDir)) return false;

  const prefix = `${sessionId}_`;
  let latest: string | null = null;

  for (const file of readdirSync(archiveDir)) {
    if (!file.startsWith(prefix)) continue;
    const charAfterPrefix = file[prefix.length];
    if (!charAfterPrefix || charAfterPrefix < "0" || charAfterPrefix > "9") continue;
    if (!latest || file > latest) latest = file;
  }

  if (!latest) return false;

  const archivePath = join(archiveDir, latest);
  let existing: Record<string, string>;
  try {
    const content = readFileSync(archivePath, "utf-8");
    if (latest.endsWith(JSON_EXTENSION)) {
      const raw = parseMetadataContent(content);
      if (!raw) return false;
      existing = flattenToStringRecord(raw);
    } else {
      existing = parseKeyValueContent(content);
    }
  } catch {
    return false;
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === "") {
      const { [key]: _, ...rest } = existing;
      existing = rest;
    } else {
      existing[key] = value;
    }
  }

  if (latest.endsWith(JSON_EXTENSION)) {
    atomicWriteFileSync(archivePath, serializeMetadataJson(unflattenFromStringRecord(existing)));
  } else {
    atomicWriteFileSync(archivePath, serializeMetadataFlat(existing));
  }
  return true;
}

// =============================================================================
// LIST (both JSON and flat formats)
// =============================================================================

export function listMetadata(dataDir: string): SessionId[] {
  const dir = dataDir;
  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter((name) => {
    if (name === "archive" || name.startsWith(".")) return false;

    if (name.endsWith(JSON_EXTENSION)) {
      const baseName = name.slice(0, -JSON_EXTENSION.length);
      if (!baseName || !SESSION_ID_COMPONENT_PATTERN.test(baseName)) return false;
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    }

    if (!VALID_SESSION_ID.test(name)) return false;
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  }).map((name) => name.endsWith(JSON_EXTENSION) ? name.slice(0, -JSON_EXTENSION.length) : name);
}

// =============================================================================
// RESERVE (atomic O_EXCL — creates empty file, format determined on first write)
// =============================================================================

export function reserveSessionId(dataDir: string, sessionId: SessionId): boolean {
  const path = metadataPathJson(dataDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// MIGRATION HELPERS (flat → JSON)
// =============================================================================

function removeFlatFormatIfPresent(dataDir: string, sessionId: SessionId): void {
  const flatPath = metadataPathFlat(dataDir, sessionId);
  if (existsSync(flatPath)) {
    try { unlinkSync(flatPath); } catch { /* concurrent delete */ }
  }
}

export function migrateFlatToJson(dataDir: string, sessionId: SessionId): boolean {
  const flatMeta = readMetadataFlat(dataDir, sessionId);
  if (!flatMeta) return false;
  writeMetadata(dataDir, sessionId, flatMeta);
  return true;
}
