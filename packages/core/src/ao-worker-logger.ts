import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
  } & Record<string, unknown>;
}

/**
 * Log AO worker events to structured files for debugging and audit purposes.
 * Logs are written to /tmp/agent-orchestrator/{projectId}/{branchName}/
 */
export class AOWorkerLogger {
  private readonly _instanceMarker: undefined;

  private constructor() {
    // Utility class - static methods only
  }

  private static isEnabled(): boolean {
    const logLevel = process.env["AO_LOG_LEVEL"]?.trim().toLowerCase();
    return logLevel === "debug" || logLevel === "info";
  }

  private static isSensitiveLoggingEnabled(): boolean {
    return process.env["AO_LOG_SENSITIVE"]?.trim().toLowerCase() === "true";
  }

  private static redactData(data: WorkerLogEntry["data"]): WorkerLogEntry["data"] {
    if (this.isSensitiveLoggingEnabled()) return data;
    const redacted = { ...data };
    if (redacted.prompt !== undefined) redacted.prompt = "[REDACTED]";
    if (redacted.systemPrompt !== undefined) redacted.systemPrompt = "[REDACTED]";
    if (redacted.launchCommand !== undefined) redacted.launchCommand = "[REDACTED]";
    return redacted;
  }

  private static getLogDir(projectId: string, branch?: string): string {
    const basePath = "/tmp/agent-orchestrator";
    if (branch) {
      // Sanitize branch name for filesystem
      const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, "_");
      return join(basePath, projectId, safeBranch);
    }
    return join(basePath, projectId);
  }

  private static ensureLogDir(path: string): void {
    try {
      mkdirSync(path, { recursive: true });
    } catch (err) {
      // Non-fatal - log to stderr if dir creation fails
      console.error(`[AOWorkerLogger] Failed to create log directory ${path}:`, err);
    }
  }

  private static writeLogEntry(entry: WorkerLogEntry, projectId: string, branch?: string): void {
    if (!this.isEnabled()) return;

    try {
      const logDir = this.getLogDir(projectId, branch);
      this.ensureLogDir(logDir);

      const logEntry = { ...entry, data: this.redactData(entry.data) };
      const logFile = join(logDir, `${entry.sessionId}.jsonl`);
      const logLine = JSON.stringify(logEntry) + "\n";

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

  static logSpawnStart(
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
        prompt: options.prompt,
        issueId: options.issueId,
        workspacePath: options.workspacePath,
        branch: options.branch,
        metadata: options.metadata,
      },
    };

    this.writeLogEntry(entry, projectId, options.branch);
  }

  static logAgentLaunch(
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
        systemPrompt: options.systemPrompt,
        workspacePath: options.workspacePath,
        branch: options.branch,
      },
    };

    this.writeLogEntry(entry, projectId, options.branch);
  }

  static logPromptDelivery(
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
        prompt: options.prompt,
        metadata: {
          deliveryMethod: options.deliveryMethod,
          success: options.success,
          error: options.error,
        },
        branch: options.branch,
      },
    };

    this.writeLogEntry(entry, projectId, options.branch);
  }

  static logSessionEvent(
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

    this.writeLogEntry(entry, projectId, branch);
  }
}
