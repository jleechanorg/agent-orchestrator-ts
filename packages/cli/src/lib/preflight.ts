/**
 * Pre-flight checks for `ao start` and `ao spawn`.
 *
 * Validates runtime prerequisites before entering the main command flow,
 * giving clear errors instead of cryptic failures.
 *
 * All checks throw on failure so callers can catch and handle uniformly.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isPortAvailable } from "./web-dir.js";
import { exec, execOrError } from "./shell.js";

/**
 * Check that the dashboard port is free.
 * Throws if the port is already in use.
 */
async function checkPort(port: number): Promise<void> {
  const free = await isPortAvailable(port);
  if (!free) {
    throw new Error(
      `Port ${port} is already in use. Free it or change 'port' in agent-orchestrator.yaml.`,
    );
  }
}

/**
 * Check that workspace packages have been compiled (TypeScript → JavaScript).
 * Verifies @jleechanorg/ao-core dist output exists from the web package's
 * node_modules, since a missing dist/ causes module resolution errors when
 * starting the dashboard. Works with both `next dev` and `next build`.
 */
async function checkBuilt(webDir: string): Promise<void> {
  const nodeModules = resolve(webDir, "node_modules", "@jleechanorg", "ao-core");
  if (!existsSync(nodeModules)) {
    throw new Error("Dependencies not installed. Run: pnpm install && pnpm build");
  }
  const coreEntry = resolve(nodeModules, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    throw new Error("Packages not built. Run: pnpm build");
  }
}

/**
 * Check that tmux is installed (required for the default runtime).
 * Throws if not installed.
 */
async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    throw new Error("tmux is not installed. Install it: brew install tmux");
  }
}

/**
 * Failure class produced by `checkGhAuth` — callers can inspect this to
 * decide whether to defer-and-retry (rate-limit) or hard-fail (no
 * credentials at all). Pre-qcr9 the daemon treated every `gh auth status`
 * failure as "not authenticated" and parked wave dispatches as
 * `coder_silent`/`auth-preflight` HUMAN_HELD, even when the failure was
 * actually a transient API rate-limit (HTTP 403/429). With this enum
 * the dispatch layer can distinguish the two and treat rate-limit as
 * a retryable, deferred condition rather than a hard auth failure.
 */
export type GhAuthFailureReason =
  | "not_installed"
  | "invalid_token"
  | "rate_limited"
  | "forbidden_other"
  | "unknown"
  | "ok";

export class GhAuthPreflightError extends Error {
  readonly reason: GhAuthFailureReason;
  readonly retryable: boolean;
  constructor(reason: GhAuthFailureReason, message: string, retryable: boolean) {
    super(message);
    this.name = "GhAuthPreflightError";
    this.reason = reason;
    this.retryable = retryable;
  }
}

/**
 * jleechan-ao-preflight-ratelimit-qcr9: classify a `gh auth status` failure
 * by its stdout/stderr signature. The four classes we care about, in
 * precedence order:
 *   - HTTP 429 / "rate limit" / "too many requests" → retryable (rate_limited)
 *   - HTTP 403 + "rate limit" → retryable (rate_limited)
 *   - HTTP 401 / "bad credentials" / "token is invalid" / "not logged in" → invalid_token
 *   - HTTP 403 otherwise → forbidden_other (e.g. SSO required)
 *   - anything else → unknown
 *
 * The classifier is best-effort; an "unknown" failure is treated as
 * non-retryable so the daemon does not spin on a genuinely broken auth
 * state.
 */
export function classifyGhAuthFailure(stdout: string, stderr: string): GhAuthFailureReason {
  // Empty stderr AND no failure markers AND a success marker → ok.
  // `gh auth status` prints the success path on stdout ("Logged in to
  // github.com as ..."), so empty stderr alone is not enough — we also
  // require an "ok"/"logged in" signal on stdout to be sure.
  const lowerStdout = stdout.toLowerCase();
  const lowerStderr = stderr.toLowerCase();
  if (
    lowerStderr.trim() === "" &&
    (lowerStdout.includes("logged in") || /\bok\b/.test(lowerStdout))
  ) {
    return "ok";
  }
  const blob = `${stdout}\n${stderr}`.toLowerCase();
  // Rate-limit FIRST (before invalid-token) because gh's 403 rate-limit
  // and 401 invalid-token responses can both contain "credentials"-adjacent
  // words ("abuse", "limit"), and the rate-limit path is the one that
  // requires retryable handling. The 429/403 rate-limit signatures are
  // distinctive enough that checking them first is unambiguous.
  if (
    /\b429\b/.test(blob) ||
    /\b403\b.*rate.?limit/.test(blob) ||
    /rate.?limit exceeded/.test(blob) ||
    /too many requests/.test(blob) ||
    /api rate limit/.test(blob)
  ) {
    return "rate_limited";
  }
  if (
    /\b401\b/.test(blob) ||
    /bad credentials/.test(blob) ||
    /token is invalid/.test(blob) ||
    /not logged in/.test(blob) ||
    /not authenticated/.test(blob) ||
    /authentication failed/.test(blob)
  ) {
    return "invalid_token";
  }
  if (/\b403\b/.test(blob)) {
    return "forbidden_other";
  }
  return "unknown";
}

/**
 * Check that the GitHub CLI is installed and authenticated.
 * Distinguishes between "not installed", "invalid token" (401),
 * "rate limited" (403/429), and other failures so the caller can
 * decide whether to retry (rate limit) or hard-fail (auth).
 */
async function checkGhAuth(): Promise<void> {
  let versionResult: { stdout: string; stderr: string };
  try {
    versionResult = await exec("gh", ["--version"]);
  } catch {
    throw new GhAuthPreflightError(
      "not_installed",
      "GitHub CLI (gh) is not installed. Install it: https://cli.github.com/",
      false,
    );
  }

  // Use execOrError so we capture stdout/stderr on BOTH success and failure
  // — `gh auth status` exits non-zero on every auth failure, and we need
  // to read what gh actually said in order to classify the failure (pre-qcr9
  // every non-zero exit was treated as "not authenticated", which masked
  // transient HTTP 403/429 rate-limit responses).
  const { stdout, stderr } = await execOrError("gh", ["auth", "status"]);

  const reason = classifyGhAuthFailure(stdout, stderr);
  if (reason === "ok") {
    return; // success — no error
  }
  switch (reason) {
    case "not_installed":
      // exec --version already covered this branch; defensive only.
      throw new GhAuthPreflightError(reason, "gh --version missing", false);
    case "invalid_token":
      throw new GhAuthPreflightError(
        reason,
        `GitHub CLI auth failed: 401/invalid credentials. Run: gh auth login. Detail: ${stderr || stdout || "(empty)"}`,
        false,
      );
    case "rate_limited":
      throw new GhAuthPreflightError(
        reason,
        `GitHub CLI auth check hit a rate limit (HTTP 403/429). This is transient — wait and retry, no need to re-authenticate. Detail: ${stderr || stdout || "(empty)"}`,
        true,
      );
    case "forbidden_other":
      throw new GhAuthPreflightError(
        reason,
        `GitHub CLI auth failed: HTTP 403 (not rate-limit — likely SSO/scopes). Check token scopes. Detail: ${stderr || stdout || "(empty)"}`,
        false,
      );
    case "unknown":
      throw new GhAuthPreflightError(
        reason,
        `GitHub CLI auth status check failed with unrecognized output. Detail: ${stderr || stdout || "(empty)"}`,
        false,
      );
  }
}

export const preflight = {
  checkPort,
  checkBuilt,
  checkTmux,
  checkGhAuth,
};
