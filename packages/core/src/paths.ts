/**
 * Path utilities for AO storage directory structure.
 *
 * V2 layout (projects/{projectId}/):
 *   getProjectDir(projectId)          → ~/.agent-orchestrator/projects/{projectId}
 *   getProjectSessionsDir(projectId)  → .../projects/{projectId}/sessions
 *   getProjectWorktreesDir(projectId) → .../projects/{projectId}/worktrees
 *   getOrchestratorPath(projectId)    → .../projects/{projectId}/orchestrator.json
 *   getSessionPath(projectId, sid)    → .../projects/{projectId}/sessions/{sid}.json
 *
 * Legacy layout ({hash}-{projectId}/):
 *   getProjectBaseDir(configPath, projectPath)     → ~/.agent-orchestrator/{hash}-{projectId}
 *   getSessionsDir(configPath, projectPath)        → .../{hash}-{projectId}/sessions
 *   ... (kept for backward compat and fork features)
 */

import { createHash } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";

export function generateConfigHash(configPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(configPath);
  } catch {
    resolved = resolve(configPath);
  }
  const configDir = dirname(resolved);
  const hash = createHash("sha256").update(configDir).digest("hex");
  return hash.slice(0, 12);
}

export function generateProjectId(projectPath: string): string {
  return basename(projectPath);
}

export function generateInstanceId(configPath: string, projectPath: string): string {
  const hash = generateConfigHash(configPath);
  const projectId = generateProjectId(projectPath);
  return `${hash}-${projectId}`;
}

export function generateSessionPrefix(projectId: string): string {
  if (projectId.length <= 4) {
    return projectId.toLowerCase();
  }

  const uppercase = projectId.match(/[A-Z]/g);
  if (uppercase && uppercase.length > 1) {
    return uppercase.join("").toLowerCase();
  }

  if (projectId.includes("-") || projectId.includes("_")) {
    const separator = projectId.includes("-") ? "-" : "_";
    return projectId
      .split(separator)
      .map((word) => word[0])
      .join("")
      .toLowerCase();
  }

  return projectId.slice(0, 3).toLowerCase();
}

// =============================================================================
// V2 PATH FUNCTIONS (projects/{projectId}/ layout)
// =============================================================================

const MAX_PROJECT_ID_LENGTH = 128;

const SAFE_PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertSafeProjectId(projectId: string): void {
  if (
    !projectId ||
    projectId === "." ||
    projectId === ".." ||
    projectId.length > MAX_PROJECT_ID_LENGTH ||
    !SAFE_PROJECT_ID_PATTERN.test(projectId)
  ) {
    throw new Error(`Unsafe project ID: "${projectId}"`);
  }
}

export function getProjectDir(projectId: string): string {
  assertSafeProjectId(projectId);
  return join(getAoBaseDir(), "projects", projectId);
}

export function getProjectSessionsDir(projectId: string): string {
  return join(getProjectDir(projectId), "sessions");
}

export function getProjectWorktreesDir(projectId: string): string {
  return join(getProjectDir(projectId), "worktrees");
}

export function getProjectFeedbackReportsDir(projectId: string): string {
  return join(getProjectDir(projectId), "feedback-reports");
}

export function getOrchestratorPath(projectId: string): string {
  return join(getProjectDir(projectId), "orchestrator.json");
}

export function getSessionPath(projectId: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectId), `${sessionId}.json`);
}

// =============================================================================
// LEGACY PATH FUNCTIONS (hash-{projectId}/ layout — kept for backward compat)
// =============================================================================

export function getProjectBaseDir(configPath: string, projectPath: string): string {
  const instanceId = generateInstanceId(configPath, projectPath);
  return join(expandHome("~/.agent-orchestrator"), instanceId);
}

export function getObservabilityBaseDir(configPath: string): string {
  const hash = generateConfigHash(configPath);
  return join(expandHome("~/.agent-orchestrator"), `${hash}-observability`);
}

export function getSessionsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "sessions");
}

export function getWorktreesDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "worktrees");
}

export function getFeedbackReportsDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "feedback-reports");
}

export function getArchiveDir(configPath: string, projectPath: string): string {
  return join(getSessionsDir(configPath, projectPath), "archive");
}

export function getOriginFilePath(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), ".origin");
}

export function generateSessionName(prefix: string, num: number): string {
  return `${prefix}-${num}`;
}

export function generateTmuxName(configPath: string, prefix: string, num: number): string {
  const hash = generateConfigHash(configPath);
  return `${hash}-${prefix}-${num}`;
}

export function parseTmuxName(tmuxName: string): {
  hash: string;
  prefix: string;
  num: number;
} | null {
  const match = tmuxName.match(/^([a-f0-9]{12})-([a-zA-Z0-9_-]+)-(\d+)$/);
  if (!match) return null;

  return {
    hash: match[1],
    prefix: match[2],
    num: parseInt(match[3], 10),
  };
}

export function parseTmuxNameV2(tmuxName: string): {
  prefix: string;
  num: number;
} | null {
  const match = tmuxName.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], num: parseInt(match[2], 10) };
}

export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

export function getAoBaseDir(): string {
  return expandHome("~/.agent-orchestrator");
}

export function getPortfolioDir(): string {
  return join(getAoBaseDir(), "portfolio");
}

export function getPreferencesPath(): string {
  return join(getPortfolioDir(), "preferences.json");
}

export function getRegisteredPath(): string {
  return join(getPortfolioDir(), "registered.json");
}

export function validateAndStoreOrigin(configPath: string, projectPath: string): void {
  const originPath = getOriginFilePath(configPath, projectPath);
  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = realpathSync(configPath);
  } catch {
    resolvedConfigPath = resolve(configPath);
  }

  if (existsSync(originPath)) {
    const stored = readFileSync(originPath, "utf-8").trim();
    if (stored !== resolvedConfigPath) {
      writeFileSync(originPath, resolvedConfigPath, "utf-8");
    }
  } else {
    const baseDir = getProjectBaseDir(configPath, projectPath);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(originPath, resolvedConfigPath, "utf-8");
  }
}

export function requireStorageKey(storageKey: string | undefined): string {
  if (!storageKey) {
    throw new Error("storageKey is required");
  }
  return storageKey;
}
