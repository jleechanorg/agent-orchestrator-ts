/**
 * SCM retry for transient 5xx errors — wraps GitHub API calls with retry on server errors.
 *
 * The existing ghWithRetry only retries rate limits (429). This adds 5xx retry
 * using the shared isRetryableHttpStatus utility. Companion module to avoid
 * modifying the upstream SCM GitHub plugin inline.
 */

import { isRetryableHttpStatus, normalizeRetryConfig } from "./utils.js";

export interface ScmRetryOptions {
  retries?: number;
  retryDelayMs?: number;
}

export async function withScmRetry<T>(
  fn: () => Promise<T>,
  options?: ScmRetryOptions,
  getStatus?: (error: unknown) => number | null,
): Promise<T> {
  const config = normalizeRetryConfig(
    options as Record<string, unknown> | undefined,
    { retries: 2, retryDelayMs: 1000 },
  );

  let lastError: unknown;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= config.retries) {
        break;
      }

      const status = getStatus?.(err) ?? extractStatus(err);
      if (status === null || !isRetryableHttpStatus(status)) {
        throw err;
      }

      const delay = config.retryDelayMs * Math.pow(2, attempt);
      console.warn(
        `[scm-retry] Transient error (status ${status}), retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${config.retries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function extractStatus(error: unknown): number | null {
  if (error instanceof Error) {
    const statusMatch = error.message.match(/\b(5\d{2}|429)\b/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1]!, 10);
      return Number.isFinite(status) ? status : null;
    }
  }
  return null;
}
