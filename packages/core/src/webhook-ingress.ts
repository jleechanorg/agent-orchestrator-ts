/**
 * WebhookIngress — HMAC verification, dedup, and event queue
 *
 * Uses Map-based in-memory dedup (future: swap to better-sqlite3 via dbPath).
 * HTTP server is intentionally excluded — this module handles ingress logic only.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SCMWebhookEvent } from "./types.js";

export interface WebhookIngressConfig {
  /** Port for future HTTP server integration */
  port: number;
  /** HMAC secret for X-Hub-Signature-256 verification */
  secret: string;
  /** SQLite path for dedup (":memory:" supported for in-process use) */
  dbPath: string;
  /** Maximum request body size in bytes (default: 10 MB) */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export class WebhookIngress {
  private readonly config: Required<WebhookIngressConfig>;
  private deliveries: Map<string, string>;
  private queue: SCMWebhookEvent[];
  private dbInitialized: boolean;

  constructor(config: WebhookIngressConfig) {
    this.config = {
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      ...config,
    };
    this.deliveries = new Map();
    this.queue = [];
    this.dbInitialized = false;
  }

  /**
   * Initialize the dedup store. Idempotent — safe to call multiple times.
   *
   * In the current Map-based implementation this is a no-op after first call.
   * A future SQLite implementation would run CREATE TABLE IF NOT EXISTS here.
   */
  initDb(): void {
    if (this.dbInitialized) return;
    // Map is initialized in constructor; mark as ready.
    this.dbInitialized = true;
  }

  /**
   * Verify an X-Hub-Signature-256 HMAC signature using constant-time comparison.
   *
   * @param payload  - Raw request body (string or Buffer)
   * @param signature - Value of the X-Hub-Signature-256 header
   * @param secret   - HMAC shared secret
   * @returns true if the signature is valid, false otherwise
   */
  verifySignature(payload: string | Buffer, signature: string, secret: string): boolean {
    if (!signature || !signature.startsWith("sha256=")) return false;

    const expected = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const expectedSig = `sha256=${expected}`;

    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);

    // timingSafeEqual requires same-length buffers; length mismatch means mismatch.
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  }

  /**
   * Check if a delivery ID has already been processed.
   *
   * @param deliveryId - Value of the X-GitHub-Delivery header
   */
  isDuplicate(deliveryId: string): boolean {
    return this.deliveries.has(deliveryId);
  }

  /**
   * Record a delivery ID as processed. Idempotent — won't throw on duplicates.
   *
   * @param deliveryId - Value of the X-GitHub-Delivery header
   * @param eventType  - GitHub event type (e.g. "pull_request", "push")
   */
  recordDelivery(deliveryId: string, eventType: string): void {
    if (!this.deliveries.has(deliveryId)) {
      this.deliveries.set(deliveryId, eventType);
    }
  }

  /**
   * Add a normalized webhook event to the FIFO queue for downstream processing.
   */
  enqueue(event: SCMWebhookEvent): void {
    this.queue.push(event);
  }

  /**
   * Remove and return the next event from the queue.
   *
   * @returns The next event, or null if the queue is empty.
   */
  dequeue(): SCMWebhookEvent | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Return the current number of events waiting in the queue.
   */
  getQueueLength(): number {
    return this.queue.length;
  }
}
