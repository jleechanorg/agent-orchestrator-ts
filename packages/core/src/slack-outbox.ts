import { randomUUID } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface OutboxEntry {
  id: string;
  message: string;
  channel?: string;
  threadTs?: string;
  priority: "high" | "normal" | "low";
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  status: "pending" | "sent" | "dead";
}

export interface OutboxConfig {
  outboxPath: string;
  deadLetterPath: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface SlackOutboxDeps {
  config: OutboxConfig;
}

const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

function readEntries(filePath: string): OutboxEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OutboxEntry);
}

export class SlackOutbox {
  private readonly config: OutboxConfig;

  constructor({ config }: SlackOutboxDeps) {
    this.config = config;
  }

  async enqueue(
    message: string,
    channel?: string,
    threadTs?: string,
    priority: string = "normal",
  ): Promise<void> {
    const normalizedPriority = (
      ["high", "normal", "low"].includes(priority) ? priority : "normal"
    ) as OutboxEntry["priority"];
    const entry: OutboxEntry = {
      id: randomUUID(),
      message,
      ...(channel !== undefined && { channel }),
      ...(threadTs !== undefined && { threadTs }),
      priority: normalizedPriority,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "pending",
    };
    appendFileSync(this.config.outboxPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async processNext(
    sender: (entry: OutboxEntry) => Promise<void>,
  ): Promise<OutboxEntry | null> {
    const entries = readEntries(this.config.outboxPath);
    const pending = entries
      .filter((e) => e.status === "pending")
      .sort(
        (a, b) =>
          (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1),
      );

    if (pending.length === 0) return null;

    const entry: OutboxEntry = { ...pending[0] };

    try {
      await sender(entry);
      entry.status = "sent";
    } catch (err) {
      entry.attempts += 1;
      entry.lastAttemptAt = new Date().toISOString();
      entry.lastError = err instanceof Error ? err.message : String(err);

      if (entry.attempts >= this.config.maxRetries) {
        entry.status = "dead";
        await this.moveToDeadLetter(entry, entry.lastError);
      }
    }

    // Rewrite outbox: remove this entry; re-add only if still pending (failed but under maxRetries)
    const remaining = entries.filter((e) => e.id !== entry.id);
    if (entry.status === "pending") {
      remaining.push(entry);
    }

    const newContent = remaining.map((e) => JSON.stringify(e)).join("\n");
    atomicWriteFileSync(
      this.config.outboxPath,
      newContent ? newContent + "\n" : "",
    );

    return entry;
  }

  async moveToDeadLetter(entry: OutboxEntry, error: string): Promise<void> {
    const deadEntry: OutboxEntry = { ...entry, status: "dead", lastError: error };
    appendFileSync(
      this.config.deadLetterPath,
      JSON.stringify(deadEntry) + "\n",
      "utf-8",
    );
  }

  async getOutboxLength(): Promise<number> {
    const entries = readEntries(this.config.outboxPath);
    return entries.filter((e) => e.status === "pending").length;
  }

  async getDeadLetterLength(): Promise<number> {
    return readEntries(this.config.deadLetterPath).length;
  }

  async drainOutbox(
    sender: (entry: OutboxEntry) => Promise<void>,
  ): Promise<void> {
    let result = await this.processNext(sender);
    while (result !== null) {
      result = await this.processNext(sender);
    }
  }
}
