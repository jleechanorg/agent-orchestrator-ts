import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SessionMetadata } from "@composio/ao-core";

export function getSessionDir(dataDir: string, projectId: string): string {
  return join(dataDir, `${projectId}-sessions`);
}

export function readMetadata(filePath: string): Partial<SessionMetadata> | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  const meta: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      meta[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return meta as Partial<SessionMetadata>;
}

export function writeMetadata(filePath: string, meta: Partial<SessionMetadata>): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(filePath, lines.join("\n") + "\n");
}

export function archiveMetadata(sessionDir: string, sessionName: string): void {
  const metaFile = join(sessionDir, sessionName);
  if (!existsSync(metaFile)) return;
  const archiveDir = join(sessionDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  renameSync(metaFile, join(archiveDir, `${sessionName}_${timestamp}`));
}

export async function listSessionFiles(sessionDir: string): Promise<string[]> {
  if (!existsSync(sessionDir)) return [];
  const entries = await readdir(sessionDir);
  return entries.filter((e) => !e.startsWith(".") && e !== "archive");
}

export async function findSessionForIssue(
  sessionDir: string,
  issueId: string,
  tmuxSessions: string[],
): Promise<string | null> {
  const lower = issueId.toLowerCase();
  const files = await listSessionFiles(sessionDir);
  for (const file of files) {
    const name = basename(file);
    if (!tmuxSessions.includes(name)) continue;
    const meta = readMetadata(join(sessionDir, file));
    if (meta?.issue && meta.issue.toLowerCase() === lower) {
      return name;
    }
  }
  return null;
}
