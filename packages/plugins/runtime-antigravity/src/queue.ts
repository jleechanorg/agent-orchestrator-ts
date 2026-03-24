/**
 * Serial async queue for Peekaboo operations.
 *
 * All accessibility API calls MUST go through this queue to prevent
 * race conditions — macOS accessibility APIs are not safe for concurrent use.
 *
 * Uses p-queue with concurrency: 1 to guarantee serial execution.
 */

import PQueue from "p-queue";

/** Singleton serial queue — shared across all peekaboo operations. */
const queue = new PQueue({ concurrency: 1 });

/**
 * Enqueue a function for serial execution.
 *
 * @param fn - Async function to execute
 * @returns The resolved value of fn
 */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return queue.add(fn) as Promise<T>;
}

/** Number of tasks currently pending (including the running one). */
export function pendingCount(): number {
  return queue.pending + queue.size;
}
