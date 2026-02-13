/**
 * Event Bus — in-process pub/sub with JSONL persistence.
 *
 * Events are OrchestratorEvent objects. Supports:
 * - Typed event listeners (by EventType)
 * - Wildcard listeners ("*")
 * - JSONL file persistence (append-only)
 * - Filtered history queries
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EventBus,
  EventFilter,
  EventType,
  EventPriority,
  OrchestratorEvent,
  SessionId,
} from "./types.js";

type EventHandler = (event: OrchestratorEvent) => void;

/**
 * Create an OrchestratorEvent with defaults filled in.
 */
export function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  }
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.includes("approved") || type.includes("ready") || type.includes("merged") || type.includes("completed")) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/** Serialize an event for JSONL storage. */
function serializeEvent(event: OrchestratorEvent): string {
  return JSON.stringify({
    ...event,
    timestamp: event.timestamp.toISOString(),
  });
}

/** Deserialize an event from JSONL. */
function deserializeEvent(line: string): OrchestratorEvent | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    return {
      ...raw,
      timestamp: new Date(raw["timestamp"] as string),
    } as OrchestratorEvent;
  } catch {
    return null;
  }
}

/**
 * Create an EventBus implementation.
 *
 * @param logPath - Path to the JSONL event log file. If null, persistence is disabled.
 */
export function createEventBus(logPath: string | null): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();
  const history: OrchestratorEvent[] = [];

  // Load existing history from JSONL file
  if (logPath && existsSync(logPath)) {
    const content = readFileSync(logPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const event = deserializeEvent(line);
      if (event) history.push(event);
    }
  }

  // Ensure log directory exists
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  function getOrCreateSet(key: string): Set<EventHandler> {
    let set = handlers.get(key);
    if (!set) {
      set = new Set();
      handlers.set(key, set);
    }
    return set;
  }

  return {
    emit(event: OrchestratorEvent): void {
      // Persist to JSONL
      if (logPath) {
        appendFileSync(logPath, serializeEvent(event) + "\n", "utf-8");
      }

      // Store in memory
      history.push(event);

      // Notify type-specific handlers
      const typeHandlers = handlers.get(event.type);
      if (typeHandlers) {
        for (const handler of typeHandlers) {
          try {
            handler(event);
          } catch {
            // Don't let handler errors break the bus
          }
        }
      }

      // Notify wildcard handlers
      const wildcardHandlers = handlers.get("*");
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            handler(event);
          } catch {
            // Don't let handler errors break the bus
          }
        }
      }
    },

    on(event: EventType | "*", handler: EventHandler): void {
      getOrCreateSet(event).add(handler);
    },

    off(event: EventType | "*", handler: EventHandler): void {
      const set = handlers.get(event);
      if (set) {
        set.delete(handler);
        if (set.size === 0) handlers.delete(event);
      }
    },

    getHistory(filter?: EventFilter): OrchestratorEvent[] {
      let result = history;

      if (filter) {
        if (filter.sessionId) {
          result = result.filter((e) => e.sessionId === filter.sessionId);
        }
        if (filter.projectId) {
          result = result.filter((e) => e.projectId === filter.projectId);
        }
        if (filter.type) {
          result = result.filter((e) => e.type === filter.type);
        }
        if (filter.priority) {
          result = result.filter((e) => e.priority === filter.priority);
        }
        if (filter.since) {
          const since = filter.since;
          result = result.filter((e) => e.timestamp >= since);
        }
        if (filter.limit) {
          result = result.slice(-filter.limit);
        }
      }

      return result;
    },
  };
}
