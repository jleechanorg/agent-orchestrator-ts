import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export interface WorkerLogEntry {
  timestamp: string;
  sessionId: string;
  projectId: string;
  agentType: string;
  runtime: string;
  event: string;
  data: {
    prompt?: string;
    systemPrompt?: string;
    launchCommand?: string;
    workspacePath?: string;
    branch?: string;
    issueId?: string;
    metadata?: Record<string, unknown>;
  };
}

function isEnabled(): boolean {
  const logLevel = process.env["AO_LOG_LEVEL"]?.trim().toLowerCase();
  return logLevel === "debug" || logLevel === "info";
}

function redactForWorkerLog(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `[redacted:${value.length} chars]`;
}

function getLogDir(projectId: string, branch?: string): string {
  const basePath = join(os.tmpdir(), "agent-orchestrator");
  if (branch) {
    // Sanitize branch name for filesystem
    const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(basePath, projectId, safeBranch);
  }
  return join(basePath, projectId);
}

function ensureLogDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    // Non-fatal - log to stderr if dir creation fails
    console.error(`[AOWorkerLogger] Failed to create log directory ${path}:`, err);
  }
}

function writeLogEntry(entry: WorkerLogEntry, projectId: string, branch?: string): void {
  if (!isEnabled()) return;

  try {
    const logDir = getLogDir(projectId, branch);
    ensureLogDir(logDir);

    const logFile = join(logDir, `${entry.sessionId}.jsonl`);
    const logLine = JSON.stringify(entry) + "\n";

    writeFileSync(logFile, logLine, { flag: "a", encoding: "utf-8" });

    // Also write to a daily summary file
    const date = new Date().toISOString().split("T")[0];
    const summaryFile = join(logDir, `${date}-summary.jsonl`);
    writeFileSync(summaryFile, logLine, { flag: "a", encoding: "utf-8" });

  } catch (err) {
    // Non-fatal - log to stderr if file write fails
    console.error(`[AOWorkerLogger] Failed to write log entry:`, err);
  }
}

/**
 * Log AO worker events to structured files for debugging and audit purposes.
 * Logs are written to {os.tmpdir()}/agent-orchestrator/{projectId}/{branchName}/
 */
export function logSpawnStart(
  sessionId: string,
  projectId: string,
  agentType: string,
  runtime: string,
  options: {
    prompt?: string;
    issueId?: string;
    workspacePath?: string;
    branch?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  const entry: WorkerLogEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    projectId,
    agentType,
    runtime,
    event: "spawn_start",
    data: {
      prompt: redactForWorkerLog(options.prompt),
      issueId: options.issueId,
      workspacePath: options.workspacePath,
      branch: options.branch,
      metadata: options.metadata,
    },
  };

  writeLogEntry(entry, projectId, options.branch);
}

export function logAgentLaunch(
  sessionId: string,
  projectId: string,
  agentType: string,
  runtime: string,
  options: {
    launchCommand: string;
    systemPrompt?: string;
    workspacePath?: string;
    branch?: string;
  }
): void {
  const entry: WorkerLogEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    projectId,
    agentType,
    runtime,
    event: "agent_launch",
    data: {
      launchCommand: options.launchCommand,
      systemPrompt: redactForWorkerLog(options.systemPrompt),
      workspacePath: options.workspacePath,
      branch: options.branch,
    },
  };

  writeLogEntry(entry, projectId, options.branch);
}

export function logPromptDelivery(
  sessionId: string,
  projectId: string,
  agentType: string,
  runtime: string,
  options: {
    prompt: string;
    deliveryMethod: "post-launch" | "launch-embedded";
    success: boolean;
    branch?: string;
    error?: string;
  }
): void {
  const entry: WorkerLogEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    projectId,
    agentType,
    runtime,
    event: "prompt_delivery",
    data: {
      prompt: redactForWorkerLog(options.prompt),
      metadata: {
        deliveryMethod: options.deliveryMethod,
        success: options.success,
        error: options.error,
      },
      branch: options.branch,
    },
  };

  writeLogEntry(entry, projectId, options.branch);
}

export function logSessionEvent(
  sessionId: string,
  projectId: string,
  agentType: string,
  runtime: string,
  event: string,
  data: Record<string, unknown>,
  branch?: string
): void {
  const entry: WorkerLogEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    projectId,
    agentType,
    runtime,
    event,
    data,
  };

  writeLogEntry(entry, projectId, branch);
}

// Backward-compatible alias (deprecated - use named exports directly)
export const AOWorkerLogger = {
  logSpawnStart,
  logAgentLaunch,
  logPromptDelivery,
  logSessionEvent,
};