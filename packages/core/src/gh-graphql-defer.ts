/**
 * Resilient GraphQL executor with retry, backoff, and deferred-state reporting.
 *
 * Design contract (bd-fy7):
 * - Rate-limit errors → retry with exponential backoff (1s → 2s → 4s, cap 30s)
 * - Non-rate-limit errors → fail immediately (do not retry)
 * - Retries exhausted → DEFER operation, continue the loop
 * - Deferred operations → tracked with attempt count + timestamp; retried on
 *   next invocation if sufficient backoff elapsed; never retried indefinitely
 *
 * This makes every GraphQL operation NON-BLOCKING: the loop never stalls on a
 * single unavailable GraphQL endpoint — it defers and continues with REST work.
 */

import { ghSleep, isGhRateLimitError } from "./gh-rate-limit.js";
import type { GraphQLExecutor } from "./auto-resolve-threads.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An item that could not complete due to persistent rate-limiting. */
export interface DeferredItem {
  /** Human-readable description of the deferred operation. */
  label: string;
  /** When the item was first deferred (ISO timestamp). */
  deferredAt: string;
  /** Total number of attempts made across all invocations. */
  attempts: number;
  /** Last error message seen. */
  lastError: string;
}

/** Result of a GraphQL invocation via a resilient executor. */
export interface ResilientResult<T> {
  /** The successfully resolved data, or null if the operation was deferred. */
  data: T | null;
  /** Operations that could not complete even after retries. */
  deferred: DeferredItem[];
  /**
   * True when at least one operation was deferred and `data` is null.
   * Callers can use this to decide whether to retry later.
   */
  wasDeferred: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;   // 1 second
const MAX_BACKOFF_MS     = 30_000;   // 30 seconds
const MAX_ATTEMPTS       = 3;        // 1 initial + 2 retries
const DEFER_MAX_ATTEMPTS = 8;        // stop deferring after 8 total attempts
const DEFER_STALE_MS     = 10 * 60 * 1_000; // 10 minutes — give up on a deferred item

// ---------------------------------------------------------------------------
// DeferredGraphQLExecutor
// ---------------------------------------------------------------------------

/**
 * Wraps a `GraphQLExecutor` with:
 * - Exponential-backoff retry on rate-limit errors
 * - Deferred-state tracking for exhausted operations
 * - Clear reporting so the caller can log / re-attempt later
 *
 * Conforms to `GraphQLExecutor` via `execute(query, variables)` (passthrough).
 * Use `executeWithLabel(label, query, variables, options)` to get retry+deferral
 * behaviour and a `ResilientResult`.
 */
export class DeferredGraphQLExecutor implements GraphQLExecutor {
  private readonly base: GraphQLExecutor;
  private readonly _deferred: Map<string, DeferredItem> = new Map();

  constructor(base: GraphQLExecutor) {
    this.base = base;
  }

  // ------------------------------------------------------------------
  // Deferred state inspection
  // ------------------------------------------------------------------

  /**
   * Summary of all currently deferred items.
   * Callers use this to report stalled operations or retry them.
   */
  get deferredItems(): ReadonlyMap<string, DeferredItem> {
    return this._deferred;
  }

  /** True when there is at least one deferred item. */
  get hasDeferred(): boolean {
    return this._deferred.size > 0;
  }

  /** Remove a deferred item (e.g. after completing it externally). */
  clearDeferred(key: string): void {
    this._deferred.delete(key);
  }

  /** Remove all deferred items. */
  clearAllDeferred(): void {
    this._deferred.clear();
  }

  // ------------------------------------------------------------------
  // GraphQLExecutor interface — passthrough, no retry
  // ------------------------------------------------------------------

  async execute(query: string, variables: Record<string, unknown>): Promise<unknown> {
    return this.base.execute(query, variables);
  }

  // ------------------------------------------------------------------
  // Retry + deferral entry point
  // ------------------------------------------------------------------

  /**
   * Execute a GraphQL query/mutation with retry + deferral.
   *
   * @param label     Unique key for deferred-state tracking; use the same label
   *                  on successive calls for a given logical operation.
   * @param query     GraphQL query or mutation string.
   * @param variables Query variables.
   * @param options   Override defaults for backoff / attempt limits.
   */
  async executeWithLabel(
    label: string,
    query: string,
    variables: Record<string, unknown>,
    options: Partial<{ maxAttempts: number; maxBackoffMs: number }> = {},
  ): Promise<ResilientResult<unknown>> {
    const maxAttempts  = options.maxAttempts  ?? MAX_ATTEMPTS;
    const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;

    const existing = this._deferred.get(label);

    // totalAttempts: cumulative across ALL invocations (for DEFER_MAX_ATTEMPTS enforcement).
    // retryAttempt: starts at 0 for each fresh retry batch (for backoff calculation).
    let totalAttempts = existing?.attempts ?? 0;
    let retryAttempt  = 0;

    // Stale check: permanently deferred after DEFER_MAX_ATTEMPTS total attempts.
    if (existing && totalAttempts >= DEFER_MAX_ATTEMPTS) {
      const elapsed = Date.now() - new Date(existing.deferredAt).getTime();
      if (elapsed < DEFER_STALE_MS) {
        return { data: null, deferred: [existing], wasDeferred: true };
      }
      // Stale window expired — reset and allow one final retry.
      this._deferred.delete(label);
      totalAttempts = 0;
    }

    // Not enough backoff elapsed since last attempt — skip without burning one.
    if (existing && totalAttempts > 0) {
      const elapsed = Date.now() - new Date(existing.deferredAt).getTime();
      // totalAttempts is how many have fired so far; the NEXT one in sequence
      // needs (totalAttempts+1) steps of backoff to have elapsed.
      const requiredBackoff = getBackoffForAttempt(totalAttempts + 1, maxBackoffMs);
      if (elapsed < requiredBackoff) {
        return { data: null, deferred: Array.from(this._deferred.values()), wasDeferred: true };
      }
    }

    let lastError: unknown;

    while (retryAttempt < maxAttempts) {
      retryAttempt++;
      totalAttempts++;
      try {
        const data = await this.base.execute(query, variables);
        this._deferred.delete(label);
        return { data, deferred: [], wasDeferred: false };
      } catch (err) {
        lastError = err;

        if (!isGhRateLimitError(err)) {
          // Non-rate-limit error — fail immediately, do not defer.
          return { data: null, deferred: [], wasDeferred: false };
        }

        if (retryAttempt < maxAttempts) {
          const backoff = getBackoffForAttempt(retryAttempt, maxBackoffMs);
          await ghSleep(backoff);
        }
      }
    }

    // All retries exhausted — record in deferred state with cumulative totalAttempts.
    const item: DeferredItem = {
      label,
      deferredAt: existing?.deferredAt ?? new Date().toISOString(),
      attempts: totalAttempts,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    };
    this._deferred.set(label, item);

    return { data: null, deferred: [item], wasDeferred: true };
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Compute exponential backoff: 2^(attempt-1) * INITIAL_BACKOFF_MS, capped. */
export function getBackoffForAttempt(
  attempt: number,
  capMs: number = MAX_BACKOFF_MS,
): number {
  const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
  return Math.min(backoff, capMs);
}

/** Convenience factory — wrap a raw executor with retry+deferral. */
export function withRetryAndDefer(base: GraphQLExecutor): DeferredGraphQLExecutor {
  return new DeferredGraphQLExecutor(base);
}
