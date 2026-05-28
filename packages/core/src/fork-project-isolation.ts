/**
 * Fork project isolation — hash-based project ID isolation.
 *
 * Companion module to paths.ts. Extracted from upstream commit 59971029
 * to avoid modifying the heavily-diverged paths.ts inline.
 *
 * Core concept: project paths in the sessions directory should use a hash
 * of the project ID to prevent collisions between projects that share
 * a basename but live in different directories.
 */

import { createHash } from "node:crypto";

const PROJECT_ID_HASH_LENGTH = 8;

/**
 * Hash a project ID for use in directory paths.
 *
 * Uses SHA-256 truncated to 8 hex chars (32 bits of entropy).
 * This prevents collisions when:
 * - Two projects share the same basename (e.g. ~/repos/a/app vs ~/repos/b/app)
 * - Project IDs contain special characters that are unsafe in paths
 *
 * @param projectId - The raw project ID (typically basename of project path)
 * @returns An 8-character hex hash string
 */
export function hashProjectId(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, PROJECT_ID_HASH_LENGTH);
}

/**
 * Create an isolated instance segment from a project ID.
 *
 * Combines the raw project ID prefix with its hash for human readability
 * and collision resistance:
 *   "agent-orchestrator" → "agent-orche-a3b4c5d6"
 *   "app"               → "app-a3b4c5d6"
 *
 * The prefix is truncated to 12 chars max to keep directory names manageable.
 */
export function isolateProjectId(projectId: string): string {
  const hash = hashProjectId(projectId);
  const prefix = projectId.length > 12 ? projectId.slice(0, 12) : projectId;
  const sanitized = prefix.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${sanitized}-${hash}`;
}
