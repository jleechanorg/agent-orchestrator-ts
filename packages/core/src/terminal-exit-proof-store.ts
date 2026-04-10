import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { getProjectBaseDir } from "./paths.js";

const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: string): void {
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

function pendingExitProofDir(configPath: string, projectPath: string): string {
  return join(getProjectBaseDir(configPath, projectPath), "pending-terminal-exit-proofs");
}

function pendingExitProofPath(configPath: string, projectPath: string, sessionId: string): string {
  validateSessionId(sessionId);
  return join(pendingExitProofDir(configPath, projectPath), sessionId);
}

export function readPendingTerminalExitProofRecordedAt(
  configPath: string,
  projectPath: string,
  sessionId: string,
): string | undefined {
  const path = pendingExitProofPath(configPath, projectPath, sessionId);
  if (!existsSync(path)) {
    return undefined;
  }
  const value = readFileSync(path, "utf8").trim();
  return value === "" ? undefined : value;
}

export function writePendingTerminalExitProofRecordedAt(
  configPath: string,
  projectPath: string,
  sessionId: string,
  recordedAt: string,
): void {
  const path = pendingExitProofPath(configPath, projectPath, sessionId);
  mkdirSync(pendingExitProofDir(configPath, projectPath), { recursive: true });
  atomicWriteFileSync(path, `${recordedAt}\n`);
}

export function deletePendingTerminalExitProofRecordedAt(
  configPath: string,
  projectPath: string,
  sessionId: string,
): void {
  const path = pendingExitProofPath(configPath, projectPath, sessionId);
  if (!existsSync(path)) {
    return;
  }
  unlinkSync(path);
}
