/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type SCMWebhookEvent,
  type SCMWebhookRequest,
  type SCMWebhookVerificationResult,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
  type BatchPRStatus,
} from "@jleechanorg/ao-core";
import {
  getWebhookHeader,
  parseWebhookBranchRef,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
} from "@jleechanorg/ao-core/scm-webhook-utils";

const execFileAsync = promisify(execFile);

/** Known bot logins that produce automated review comments */
const DEFAULT_BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "lgtm-com[bot]",
  "coderabbitai[bot]",
  "copilot-pull-request-reviewer",
  "copilot-pull-request-reviewer[bot]",
  "Copilot",
  "chatgpt-codex-connector[bot]",
]);

function buildBotAuthors(config?: Record<string, unknown>): Set<string> {
  const extra = config?.extraBotAuthors;
  if (!Array.isArray(extra) || extra.length === 0) return DEFAULT_BOT_AUTHORS;
  return new Set([
    ...DEFAULT_BOT_AUTHORS,
    ...(extra as string[]).filter((x) => typeof x === "string"),
  ]);
}

// ---------------------------------------------------------------------------
// Rate Limit Handling
// ---------------------------------------------------------------------------

const RATE_LIMIT_ERROR_PATTERNS = [
  "rate limit",
  "rate Limit",
  "API rate limit",
  "GraphQL rate limit",
  "rate limit exceeded",
  "Too Many Requests",
];

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (
    RATE_LIMIT_ERROR_PATTERNS.some((pattern) => msg.toLowerCase().includes(pattern.toLowerCase()))
  ) {
    return true;
  }
  if (error instanceof Error && error.cause) {
    return isRateLimitError(error.cause);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parsed `gh pr view ... --json a,b,c` for REST fallback synthesis. */
type PrViewRestConversion = {
  repo: string;
  prNumber: string;
  jsonFields: string[];
};

function parsePrViewRestConversion(args: string[]): PrViewRestConversion | null {
  if (args[0] !== "pr" || args[1] !== "view") return null;

  const prNumber = args[2];
  if (!prNumber || !/^\d+$/.test(prNumber)) return null;

  const repoIdx = args.indexOf("--repo");
  if (repoIdx === -1 || !args[repoIdx + 1]) return null;

  const repo = args[repoIdx + 1];
  const jIdx = args.indexOf("--json");
  const jsonFields =
    jIdx !== -1 && args[jIdx + 1]
      ? args[jIdx + 1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return { repo, prNumber, jsonFields };
}

/** Map GitHub REST `mergeable_state` to GraphQL-style `mergeStateStatus` tokens. */
function restMergeableStateToGraphqlMergeStateStatus(raw: string): string {
  const up = raw.toUpperCase();
  const map: Record<string, string> = {
    CLEAN: "CLEAN",
    DIRTY: "DIRTY",
    BLOCKED: "BLOCKED",
    UNSTABLE: "UNSTABLE",
    UNKNOWN: "UNKNOWN",
    BEHIND: "BEHIND",
    DRAFT: "DRAFT",
  };
  return map[up] ?? (up || "UNKNOWN");
}

type RestReviewRow = {
  state?: string;
  user?: { login?: string };
  body?: string;
  submitted_at?: string;
};

/**
 * Approximate `gh pr view --json reviewDecision` from REST /pulls/{n}/reviews.
 * Empty list is treated as REVIEW_REQUIRED (conservative vs GraphQL "no decision").
 *
 * bd-77b fix: COMMENTED reviews are non-decisive — they don't override or reset an
 * existing APPROVED or CHANGES_REQUESTED decision. Only the latest *decisive* review
 * per reviewer (APPROVED / CHANGES_REQUESTED) counts. PENDING is still REVIEW_REQUIRED.
 * This prevents incremental COMMENTED reviews from CodeRabbit (e.g., after it has
 * already APPROVED) from being treated as a new review decision that blocks the merge
 * gate.
 */
function deriveReviewDecisionGraphqlFromReviews(reviewsUnknown: unknown): string {
  if (!Array.isArray(reviewsUnknown)) return "REVIEW_REQUIRED";
  const rows = reviewsUnknown as RestReviewRow[];
  if (rows.length === 0) return "REVIEW_REQUIRED";

  // Collect latest *decisive* review per user (ignore COMMENTED and PENDING for
  // decision purposes; they don't override an existing decision).
  const decisiveStates = new Set(["APPROVED", "CHANGES_REQUESTED"]);
  const byUser = new Map<string, RestReviewRow>();
  for (const r of rows) {
    const login = r.user?.login ?? "";
    if (!decisiveStates.has((r.state ?? "").toUpperCase())) continue;
    const prev = byUser.get(login);
    const t = r.submitted_at ? Date.parse(r.submitted_at) : 0;
    const pt = prev?.submitted_at ? Date.parse(prev.submitted_at) : 0;
    if (!prev || t >= pt) byUser.set(login, r);
  }
  const latest = [...byUser.values()];

  if (latest.some((r) => (r.state ?? "").toUpperCase() === "CHANGES_REQUESTED")) {
    return "CHANGES_REQUESTED";
  }
  if (latest.length > 0 && latest.every((r) => (r.state ?? "").toUpperCase() === "APPROVED")) {
    return "APPROVED";
  }
  return "REVIEW_REQUIRED";
}

function mapRestReviewsToPrViewReviewsShape(reviewsUnknown: unknown): Array<{
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
}> {
  if (!Array.isArray(reviewsUnknown)) return [];
  return (reviewsUnknown as RestReviewRow[]).map((r) => ({
    author: { login: r.user?.login ?? "unknown" },
    state: r.state ?? "",
    body: r.body ?? "",
    submittedAt: r.submitted_at ?? "",
  }));
}

function synthesizePrViewJsonFromRest(
  rest: Record<string, unknown>,
  jsonFields: string[],
  opts: { reviewDecision?: string; reviewsPayload?: unknown; statusCheckRollup?: unknown[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const want = new Set(jsonFields);

  if (want.has("state")) {
    out.state = rest.state;
    if (rest.merged !== undefined) out.merged = rest.merged;
  }
  if (want.has("title") && rest.title !== undefined) out.title = rest.title;
  if (want.has("additions") && rest.additions !== undefined) out.additions = rest.additions;
  if (want.has("deletions") && rest.deletions !== undefined) out.deletions = rest.deletions;

  if (want.has("mergeable")) {
    const m = rest.mergeable;
    if (m === true) out.mergeable = "MERGEABLE";
    else if (m === false) out.mergeable = "CONFLICTING";
    else if (m === null) out.mergeable = "UNKNOWN";
    else if (typeof m === "string") out.mergeable = m;
    else out.mergeable = "UNKNOWN";
  }

  if (want.has("isDraft")) {
    out.isDraft = Boolean(rest.draft);
  }

  if (want.has("mergeStateStatus")) {
    const rawMs = typeof rest.mergeable_state === "string" ? rest.mergeable_state : "";
    out.mergeStateStatus = restMergeableStateToGraphqlMergeStateStatus(rawMs);
  }

  if (want.has("reviewDecision")) {
    out.reviewDecision = opts.reviewDecision ?? "REVIEW_REQUIRED";
  }

  if (want.has("reviews") && opts.reviewsPayload !== undefined) {
    out.reviews = mapRestReviewsToPrViewReviewsShape(opts.reviewsPayload);
  }

  if (want.has("statusCheckRollup") && opts.statusCheckRollup !== undefined) {
    out.statusCheckRollup = opts.statusCheckRollup;
  }

  for (const f of jsonFields) {
    if (f in out || !(f in rest)) continue;
    out[f] = rest[f];
  }

  return out;
}

async function fetchPrViewFallbackAsJson(
  conv: PrViewRestConversion,
  cwd?: string,
): Promise<string> {
  const pullRaw = await execCli("gh", ["api", `repos/${conv.repo}/pulls/${conv.prNumber}`], cwd);
  const restObj = JSON.parse(pullRaw) as Record<string, unknown>;

  let reviewDecision: string | undefined;
  let reviewsPayload: unknown;
  const needReviews =
    conv.jsonFields.includes("reviewDecision") || conv.jsonFields.includes("reviews");

  if (needReviews) {
    try {
      const revRaw = await execCli(
        "gh",
        ["api", `repos/${conv.repo}/pulls/${conv.prNumber}/reviews`],
        cwd,
      );
      reviewsPayload = JSON.parse(revRaw);
      if (conv.jsonFields.includes("reviewDecision")) {
        reviewDecision = deriveReviewDecisionGraphqlFromReviews(reviewsPayload);
      }
    } catch (err) {
      // If the caller explicitly requested the reviews list, propagate the error
      // rather than silently returning an empty reviews field (data loss).
      if (conv.jsonFields.includes("reviews")) throw err;
      reviewDecision = "REVIEW_REQUIRED";
    }
  }

  // Fetch check-runs via REST when statusCheckRollup is requested.
  // The REST PR object doesn't include statusCheckRollup, so we synthesize it
  // from the /commits/{sha}/check-runs endpoint.
  let statusCheckRollup: unknown[] | undefined;
  if (conv.jsonFields.includes("statusCheckRollup")) {
    const headObj = restObj.head as Record<string, unknown> | undefined;
    const sha = typeof headObj?.sha === "string" ? headObj.sha : undefined;
    if (sha) {
      try {
        const checksRaw = await execCli(
          "gh",
          ["api", `repos/${conv.repo}/commits/${sha}/check-runs`],
          cwd,
        );
        const checksData = JSON.parse(checksRaw) as { check_runs?: unknown[] };
        statusCheckRollup = (checksData.check_runs ?? []).map(
          (run: Record<string, unknown> | unknown) => {
            const r = run as Record<string, unknown>;
            return {
              name: r.name,
              state: mapCheckRunConclusionToState(r.conclusion, r.status),
              detailsUrl: r.html_url,
            };
          },
        );
      } catch {
        // Best-effort: return empty rollup rather than failing the whole fallback
        statusCheckRollup = [];
      }
    }
  }

  return JSON.stringify(
    synthesizePrViewJsonFromRest(restObj, conv.jsonFields, {
      reviewDecision,
      reviewsPayload,
      statusCheckRollup,
    }),
  );
}

/**
 * Execute gh CLI with rate limit retry and fallback to REST API.
 * Uses exponential backoff for rate limit errors, then falls back to curl-based REST calls.
 */
async function ghWithRetry(args: string[], cwd?: string, maxRetries = 3): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await execCli("gh", args, cwd);
    } catch (err) {
      lastError = err;

      // Check if it's a rate limit error
      if (isRateLimitError(err)) {
        // Skip sleep on final attempt - no more retries anyway
        if (attempt < maxRetries - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30s backoff
          console.warn(
            `GitHub rate limit detected, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(backoffMs);
        }
      } else {
        // Non-rate-limit error, don't retry
        throw err;
      }
    }
  }

  // All retries exhausted
  // Only attempt REST fallback for explicit `gh api ...` calls that the fallback supports.
  if (args[0] === "api") {
    console.warn("Gh CLI rate limit retries exhausted, trying REST API fallback for `gh api` call");
    try {
      return await ghRestFallback(args);
    } catch {
      // If the REST fallback cannot safely handle these args (for example,
      // unsupported `gh api` forms like GraphQL), rethrow the original error
      // from the final failed `gh` invocation instead of a new one.
      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new Error(String(lastError));
    }
  }

  // Attempt REST fallback for `gh pr view` commands: fetch pull (+ reviews when needed) and
  // synthesize the same JSON shape as `gh pr view --json …`.
  if (args[0] === "pr" && args[1] === "view") {
    const conv = parsePrViewRestConversion(args);
    if (conv) {
      console.warn(
        "Gh CLI rate limit retries exhausted, trying REST API fallback for `gh pr view` call",
      );
      return await fetchPrViewFallbackAsJson(conv, cwd);
    }
  }

  // No fallback available — rethrow the last error.
  console.warn("Gh CLI rate limit retries exhausted, no REST fallback available");
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError));
}

/**
 * Fallback to direct REST API calls using curl when gh CLI is rate limited.
 * Extracts the API endpoint from gh args and calls it directly.
 *
 * Supported forms (examples):
 *   gh api repos/owner/repo/pulls
 *   gh api /repos/owner/repo/pulls
 *   gh api repos/owner/repo/pulls?per_page=100
 *   gh api repos/owner/repo/pulls --method GET
 *
 * Unsupported forms (examples):
 *   gh api graphql
 *   gh pr list
 *
 * For unsupported forms, this function will throw so that the caller
 * (ghWithRetry) can rethrow the original gh error instead of attempting
 * a malformed curl call.
 */
export async function ghRestFallback(args: string[]): Promise<string> {
  // We only support `gh api ...` invocations here.
  if (!Array.isArray(args) || args.length === 0 || args[0] !== "api") {
    throw new Error("ghRestFallback only supports `gh api` commands");
  }

  const apiArgs = args.slice(1);
  if (apiArgs.length === 0) {
    throw new Error("ghRestFallback: missing endpoint for `gh api` command");
  }

  // Find the first positional argument (endpoint) — skip flags like --method, -X, etc.
  let endpoint = "";
  for (let i = 0; i < apiArgs.length; i++) {
    const arg = apiArgs[i];
    if (arg === "--method" || arg === "-X") {
      i++; // Skip the next argument (the method value)
    } else if (!arg.startsWith("-")) {
      endpoint = arg;
      break;
    }
  }
  if (!endpoint) {
    throw new Error("ghRestFallback: missing endpoint for `gh api` command");
  }

  // Explicitly reject GraphQL usages like `gh api graphql` so we don't
  // attempt to construct a bogus REST URL.
  if (endpoint === "graphql" || endpoint.startsWith("graphql/")) {
    throw new Error("ghRestFallback does not support GraphQL queries");
  }

  // Remove leading slash if present
  if (endpoint.startsWith("/")) {
    endpoint = endpoint.slice(1);
  }

  // NOTE: We keep the 'repos/' prefix because GitHub REST API requires it.
  // gh uses repos/owner/repo/path and REST API is https://api.github.com/repos/owner/repo/path

  // Get authentication token for the REST API call
  let token = "";
  try {
    const { stdout: tokenOutput } = await execFileAsync("gh", ["auth", "token"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    token = tokenOutput.trim();
  } catch {
    // No auth available - continue without token (will hit lower rate limits)
  }

  // Build query string from remaining args (e.g., --method GET, -F, etc.)
  // We'll capture anything that looks like a query param (?key=value)
  const queryParts: string[] = [];
  const curlFlags: string[] = [];

  for (let i = 1; i < apiArgs.length; i++) {
    const arg = apiArgs[i];
    if (arg.startsWith("?")) {
      // Query string parameter
      queryParts.push(arg.slice(1));
    } else if (arg.startsWith("--method") || arg === "-X") {
      // Pass HTTP method through to curl
      curlFlags.push("-X", apiArgs[i + 1] || "GET");
      i++; // Skip the next arg since we consumed it
    } else if (arg.startsWith("-") || arg.startsWith("--")) {
      // Pass other flags through (e.g., --header, -H)
      curlFlags.push(arg);
      if (apiArgs[i + 1] && !apiArgs[i + 1].startsWith("-")) {
        curlFlags.push(apiArgs[i + 1]);
        i++;
      }
    } else if (!arg.includes("=") && !arg.includes("/")) {
      // This might be additional path segments or other values
      // For now, just pass them through
    }
  }

  // Construct the final URL
  let url = `https://api.github.com/${endpoint}`;
  if (queryParts.length > 0) {
    url += "?" + queryParts.join("&");
  }

  // Build curl command with authentication and error handling
  const curlArgs = [
    "-f", // Fail on HTTP 4xx/5xx
    "-sS", // Silent but show errors
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ];

  // Add Authorization header if we have a token
  if (token) {
    curlArgs.push("-H", `Authorization: Bearer ${token}`);
  }

  curlArgs.push(...curlFlags, url);

  try {
    const { stdout } = await execFileAsync("curl", curlArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`REST fallback failed: ${(err as Error).message}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecCommand = "gh" | "git";

async function execCli(bin: ExecCommand, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      ...(cwd ? { cwd } : {}),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`${bin} ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function gh(args: string[]): Promise<string> {
  return ghWithRetry(args);
}

async function ghInDir(args: string[], cwd: string): Promise<string> {
  return ghWithRetry(args, cwd);
}

async function git(args: string[], cwd: string): Promise<string> {
  return execCli("git", args, cwd);
}

/**
 * Retrieve the GitHub token via `gh auth token` as a fallback when no
 * environment variable token is present.
 */
async function getGhToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map REST check-run conclusion/status to the GraphQL-style state string
 * used in `statusCheckRollup` entries.
 */
function mapCheckRunConclusionToState(
  conclusion: unknown,
  status: unknown,
): string {
  if (typeof conclusion === "string" && conclusion) {
    const c = conclusion.toUpperCase();
    if (c === "SUCCESS") return "SUCCESS";
    if (c === "FAILURE") return "FAILURE";
    if (c === "NEUTRAL") return "NEUTRAL";
    if (c === "CANCELLED") return "CANCELLED";
    if (c === "TIMED_OUT") return "TIMED_OUT";
    if (c === "ACTION_REQUIRED") return "ACTION_REQUIRED";
    if (c === "SKIPPED") return "SKIPPED";
    return c;
  }
  // No conclusion yet — map from status
  if (typeof status === "string") {
    const s = status.toUpperCase();
    if (s === "COMPLETED") return "SUCCESS";
    if (s === "IN_PROGRESS") return "IN_PROGRESS";
    if (s === "QUEUED") return "QUEUED";
    return s;
  }
  return "PENDING";
}

function parseProjectRepo(projectRepo: string): [string, string] {
  const parts = projectRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${projectRepo}", expected "owner/repo"`);
  }
  return [parts[0], parts[1]];
}

function prInfoFromView(
  data: {
    number: number;
    url: string;
    title: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  },
  projectRepo: string,
): PRInfo {
  const [owner, repo] = parseProjectRepo(projectRepo);

  return {
    number: data.number,
    url: data.url,
    title: data.title,
    owner,
    repo,
    branch: data.headRefName,
    baseBranch: data.baseRefName,
    isDraft: data.isDraft,
  };
}

function isUnsupportedPrChecksJsonError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /pr checks/i.test(err.message) && /unknown json field/i.test(err.message);
}

function mapRawCheckStateToStatus(rawState: string | undefined): CICheck["status"] {
  const state = (rawState ?? "").toUpperCase();
  if (state === "IN_PROGRESS") return "running";
  if (
    state === "PENDING" ||
    state === "QUEUED" ||
    state === "REQUESTED" ||
    state === "WAITING" ||
    state === "EXPECTED"
  ) {
    return "pending";
  }
  if (state === "SUCCESS") return "passed";
  if (
    state === "FAILURE" ||
    state === "TIMED_OUT" ||
    state === "CANCELLED" ||
    state === "ACTION_REQUIRED" ||
    state === "ERROR"
  ) {
    return "failed";
  }
  if (
    state === "SKIPPED" ||
    state === "NEUTRAL" ||
    state === "STALE" ||
    state === "NOT_REQUIRED" ||
    state === "NONE" ||
    state === ""
  ) {
    return "skipped";
  }

  return "skipped";
}

async function getCIChecksFromStatusRollup(pr: PRInfo): Promise<CICheck[]> {
  const raw = await gh([
    "pr",
    "view",
    String(pr.number),
    "--repo",
    repoFlag(pr),
    "--json",
    "statusCheckRollup",
  ]);

  const data: { statusCheckRollup?: unknown[] } = JSON.parse(raw);
  const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];

  return rollup
    .map((entry): CICheck | null => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const name =
        (typeof row["name"] === "string" && row["name"]) ||
        (typeof row["context"] === "string" && row["context"]);
      if (!name) return null;

      const rawState =
        typeof row["conclusion"] === "string"
          ? row["conclusion"]
          : typeof row["state"] === "string"
            ? row["state"]
            : typeof row["status"] === "string"
              ? row["status"]
              : undefined;

      const url =
        (typeof row["link"] === "string" && row["link"]) ||
        (typeof row["detailsUrl"] === "string" && row["detailsUrl"]) ||
        (typeof row["targetUrl"] === "string" && row["targetUrl"]) ||
        undefined;

      const startedAtRaw =
        typeof row["startedAt"] === "string"
          ? row["startedAt"]
          : typeof row["createdAt"] === "string"
            ? row["createdAt"]
            : undefined;
      const completedAtRaw =
        typeof row["completedAt"] === "string" ? row["completedAt"] : undefined;

      const check: CICheck = {
        name,
        status: mapRawCheckStateToStatus(rawState),
        conclusion: typeof rawState === "string" ? rawState.toUpperCase() : undefined,
        startedAt: startedAtRaw ? new Date(startedAtRaw) : undefined,
        completedAt: completedAtRaw ? new Date(completedAtRaw) : undefined,
      };

      if (url) {
        check.url = url;
      }

      return check;
    })
    .filter((check): check is CICheck => check !== null);
}

function getGitHubWebhookConfig(project: ProjectConfig) {
  const webhook = project.scm?.webhook;
  return {
    enabled: webhook?.enabled !== false,
    path: webhook?.path ?? "/api/webhooks/github",
    secretEnvVar: webhook?.secretEnvVar,
    signatureHeader: webhook?.signatureHeader ?? "x-hub-signature-256",
    eventHeader: webhook?.eventHeader ?? "x-github-event",
    deliveryHeader: webhook?.deliveryHeader ?? "x-github-delivery",
    maxBodyBytes: webhook?.maxBodyBytes,
  };
}

function verifyGitHubSignature(
  body: string | Uint8Array,
  secret: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function parseGitHubRepository(payload: Record<string, unknown>) {
  const repository = payload["repository"];
  if (!repository || typeof repository !== "object") return undefined;
  const repo = repository as Record<string, unknown>;
  const ownerValue = repo["owner"];
  const ownerLogin =
    ownerValue && typeof ownerValue === "object"
      ? (ownerValue as Record<string, unknown>)["login"]
      : undefined;
  const owner = typeof ownerLogin === "string" ? ownerLogin : undefined;
  const name = typeof repo["name"] === "string" ? repo["name"] : undefined;
  if (!owner || !name) return undefined;
  return { owner, name };
}

function parseGitHubWebhookEvent(
  request: SCMWebhookRequest,
  payload: Record<string, unknown>,
  config: ReturnType<typeof getGitHubWebhookConfig>,
): SCMWebhookEvent | null {
  const rawEventType = getWebhookHeader(request.headers, config.eventHeader);
  if (!rawEventType) return null;

  const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
  const repository = parseGitHubRepository(payload);
  const action = typeof payload["action"] === "string" ? payload["action"] : rawEventType;

  if (rawEventType === "pull_request") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "github",
      kind: "pull_request",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["number"] === "number"
          ? (payload["number"] as number)
          : typeof pr["number"] === "number"
            ? (pr["number"] as number)
            : undefined,
      branch: typeof head?.["ref"] === "string" ? head["ref"] : undefined,
      sha: typeof head?.["sha"] === "string" ? head["sha"] : undefined,
      timestamp: parseWebhookTimestamp(pr["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "pull_request_review" || rawEventType === "pull_request_review_comment") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "github",
      kind: rawEventType === "pull_request_review" ? "review" : "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["number"] === "number"
          ? (payload["number"] as number)
          : typeof pr["number"] === "number"
            ? (pr["number"] as number)
            : undefined,
      branch: typeof head?.["ref"] === "string" ? head["ref"] : undefined,
      sha: typeof head?.["sha"] === "string" ? head["sha"] : undefined,
      timestamp:
        rawEventType === "pull_request_review"
          ? parseWebhookTimestamp(
              (payload["review"] as Record<string, unknown> | undefined)?.["submitted_at"],
            )
          : parseWebhookTimestamp(
              (payload["comment"] as Record<string, unknown> | undefined)?.["updated_at"] ??
                (payload["comment"] as Record<string, unknown> | undefined)?.["created_at"],
            ),
      data: payload,
    };
  }

  if (rawEventType === "issue_comment") {
    const issue = payload["issue"];
    if (!issue || typeof issue !== "object") return null;
    const issueRecord = issue as Record<string, unknown>;
    if (!("pull_request" in issueRecord)) return null;
    return {
      provider: "github",
      kind: "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber: typeof issueRecord["number"] === "number" ? issueRecord["number"] : undefined,
      timestamp: parseWebhookTimestamp(
        (payload["comment"] as Record<string, unknown> | undefined)?.["updated_at"] ??
          (payload["comment"] as Record<string, unknown> | undefined)?.["created_at"],
      ),
      data: payload,
    };
  }

  if (rawEventType === "check_run" || rawEventType === "check_suite") {
    const check = payload[rawEventType] as Record<string, unknown> | undefined;
    const pullRequests = Array.isArray(check?.["pull_requests"])
      ? (check?.["pull_requests"] as Array<Record<string, unknown>>)
      : [];
    const firstPR = pullRequests[0];
    return {
      provider: "github",
      kind: "ci",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber: typeof firstPR?.["number"] === "number" ? firstPR["number"] : undefined,
      branch:
        typeof check?.["head_branch"] === "string"
          ? (check["head_branch"] as string)
          : typeof (check?.["check_suite"] as Record<string, unknown> | undefined)?.[
                "head_branch"
              ] === "string"
            ? ((check?.["check_suite"] as Record<string, unknown>)["head_branch"] as string)
            : undefined,
      sha: typeof check?.["head_sha"] === "string" ? (check["head_sha"] as string) : undefined,
      timestamp: parseWebhookTimestamp(check?.["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "status") {
    const branches = Array.isArray(payload["branches"])
      ? (payload["branches"] as Array<Record<string, unknown>>)
      : [];
    return {
      provider: "github",
      kind: "ci",
      action: typeof payload["state"] === "string" ? (payload["state"] as string) : action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseWebhookBranchRef(branches[0]?.["name"] ?? payload["ref"]),
      sha: typeof payload["sha"] === "string" ? (payload["sha"] as string) : undefined,
      timestamp: parseWebhookTimestamp(payload["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "push") {
    const headCommit =
      payload["head_commit"] && typeof payload["head_commit"] === "object"
        ? (payload["head_commit"] as Record<string, unknown>)
        : undefined;
    return {
      provider: "github",
      kind: "push",
      action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseWebhookBranchRef(payload["ref"]),
      sha: typeof payload["after"] === "string" ? (payload["after"] as string) : undefined,
      timestamp: parseWebhookTimestamp(headCommit?.["timestamp"] ?? payload["updated_at"]),
      data: payload,
    };
  }

  return {
    provider: "github",
    kind: "unknown",
    action,
    rawEventType,
    deliveryId,
    repository,
    timestamp: parseWebhookTimestamp(payload["updated_at"]),
    data: payload,
  };
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * When tests or callers pass a REST-shaped pull payload (boolean/null mergeable,
 * mergeable_state, draft) into merge readiness logic, map into GraphQL-style
 * fields and avoid treating missing reviewDecision as implicit approval.
 */
function normalizeMergePayloadFromRestShape(data: Record<string, unknown>): void {
  const m = data["mergeable"];
  const hasRestMergeable = typeof m === "boolean" || m === null;
  const hasRestMergeState = typeof data["mergeable_state"] === "string";
  if (!hasRestMergeable && !hasRestMergeState) return;

  if (typeof data["mergeable_state"] === "string" && data["mergeStateStatus"] === undefined) {
    data["mergeStateStatus"] = restMergeableStateToGraphqlMergeStateStatus(data["mergeable_state"]);
  }
  if (typeof data["draft"] === "boolean" && data["isDraft"] === undefined) {
    data["isDraft"] = data["draft"];
  }
  // reviewDecision can be null (no reviews requested) or undefined (not requested).
  // Treat both as "REVIEW_REQUIRED" for conservative fail-closed behavior.
  if (data["reviewDecision"] === null || data["reviewDecision"] === undefined) {
    data["reviewDecision"] = "REVIEW_REQUIRED";
  }
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitHubSCM(config?: Record<string, unknown>): SCM {
  const BOT_AUTHORS = buildBotAuthors(config);
  return {
    name: "github",

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      const config = getGitHubWebhookConfig(project);
      if (!config.enabled) {
        return { ok: false, reason: "Webhook is disabled for this project" };
      }
      if (request.method.toUpperCase() !== "POST") {
        return { ok: false, reason: "Webhook requests must use POST" };
      }
      if (
        config.maxBodyBytes !== undefined &&
        Buffer.byteLength(request.body, "utf8") > config.maxBodyBytes
      ) {
        return { ok: false, reason: "Webhook payload exceeds configured maxBodyBytes" };
      }

      const eventType = getWebhookHeader(request.headers, config.eventHeader);
      if (!eventType) {
        return { ok: false, reason: `Missing ${config.eventHeader} header` };
      }

      const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
      const secretName = config.secretEnvVar;
      if (!secretName) {
        return { ok: true, deliveryId, eventType };
      }

      const secret = process.env[secretName];
      if (!secret) {
        return { ok: false, reason: `Webhook secret env var ${secretName} is not configured` };
      }

      const signature = getWebhookHeader(request.headers, config.signatureHeader);
      if (!signature) {
        return { ok: false, reason: `Missing ${config.signatureHeader} header` };
      }

      if (!verifyGitHubSignature(request.rawBody ?? request.body, secret, signature)) {
        return {
          ok: false,
          reason: "Webhook signature verification failed",
          deliveryId,
          eventType,
        };
      }

      return { ok: true, deliveryId, eventType };
    },

    async parseWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookEvent | null> {
      const config = getGitHubWebhookConfig(project);
      const payload = parseWebhookJsonObject(request.body);
      return parseGitHubWebhookEvent(request, payload, config);
    },

    async listOpenPRs(project: ProjectConfig): Promise<PRInfo[]> {
      const [owner, repo] = parseProjectRepo(project.repo);
      type RestPull = {
        number: number;
        html_url: string;
        title: string;
        head: { ref: string };
        base: { ref: string };
        draft: boolean;
      };

      // Errors propagate naturally so the caller can distinguish "no open PRs"
      // from "API failure" and log accordingly (lifecycle.backfill.list_failed).
      const raw = await gh([
        "api",
        `repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
      ]);
      const prs: RestPull[] = JSON.parse(raw);
      return prs.map((pr) =>
        prInfoFromView(
          {
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref,
            isDraft: pr.draft,
          },
          project.repo,
        ),
      );
    },

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;
      const [owner, repo] = parseProjectRepo(project.repo);

      // Primary: gh pr list --head (GraphQL-backed) — finds PRs regardless of
      // which fork owner the head branch lives on, unlike the owner-scoped REST
      // `head=owner:branch` filter which can miss fork-PRs.
      // REST is only a fallback when GraphQL fails (rate-limit, network error).
      try {
        const listRaw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--head",
          session.branch,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
          "--limit",
          "1",
        ]);

        const listPrs: Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        }> = JSON.parse(listRaw);

        if (listPrs.length > 0) {
          return prInfoFromView(listPrs[0], project.repo);
        }

        // GraphQL succeeded but no PR found — skip REST fallback since it is
        // owner-scoped and cannot improve on a "no PR" result from GraphQL.
        return null;
      } catch {
        // REST fallback: only reached when GraphQL throws (rate-limit, network
        // error). The owner-scoped `head=owner:branch` filter is a best-effort
        // scan that may miss fork-owner PRs — but it is the only safe fallback
        // that avoids adding GraphQL cost in steady-state.
        try {
          const raw = await gh([
            "api",
            `repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(session.branch)}&state=open&per_page=1`,
          ]);

          const prs: Array<{
            number: number;
            html_url: string;
            title: string;
            head: { ref: string };
            base: { ref: string };
            draft: boolean;
          }> = JSON.parse(raw);

          if (prs.length > 0) {
            const pr = prs[0];
            return prInfoFromView(
              {
                number: pr.number,
                url: pr.html_url,
                title: pr.title,
                headRefName: pr.head.ref,
                baseRefName: pr.base.ref,
                isDraft: pr.draft,
              },
              project.repo,
            );
          }
        } catch {
          // Both GraphQL and REST failed — return null per Promise<PRInfo | null>
        }
      }

      return null;
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      // Use REST API to avoid GraphQL rate limits
      const [owner, repo] = parseProjectRepo(project.repo);
      const raw = await gh(["api", `repos/${owner}/${repo}/pulls/${reference}`]);

      const data: {
        number: number;
        url: string;
        title: string;
        head: { ref: string };
        base: { ref: string };
        draft: boolean;
      } = JSON.parse(raw);

      return prInfoFromView(
        {
          number: data.number,
          url: data.url,
          title: data.title,
          headRefName: data.head.ref,
          baseRefName: data.base.ref,
          isDraft: data.draft,
        },
        project.repo,
      );
    },

    async assignPRToCurrentUser(pr: PRInfo): Promise<void> {
      await gh(["pr", "edit", String(pr.number), "--repo", repoFlag(pr), "--add-assignee", "@me"]);
    },

    async checkoutPR(pr: PRInfo, workspacePath: string): Promise<boolean> {
      const currentBranch = await git(["branch", "--show-current"], workspacePath);
      if (currentBranch === pr.branch) return false;

      const dirty = await git(["status", "--porcelain"], workspacePath);
      if (dirty) {
        throw new Error(
          `Workspace has uncommitted changes; cannot switch to PR branch "${pr.branch}" safely`,
        );
      }

      await ghInDir(["pr", "checkout", String(pr.number), "--repo", repoFlag(pr)], workspacePath);
      return true;
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state",
      ]);
      const data: { state: string; merged?: boolean } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      if (s === "MERGED") return "merged";
      // REST API returns {state: "closed", merged: true} for merged PRs
      if (data.merged === true) return "merged";
      if (s === "CLOSED") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state,title,additions,deletions",
      ]);
      const data: {
        state: string;
        merged?: boolean;
        title: string;
        additions: number;
        deletions: number;
      } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      // REST API returns {state: "closed", merged: true} for merged PRs
      const state: PRState =
        s === "MERGED" || data.merged === true ? "merged" : s === "CLOSED" ? "closed" : "open";
      return {
        state,
        title: data.title ?? "",
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      try {
        await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
      } catch (err) {
        if (!isRateLimitError(err)) throw err;

        // Rate limit hit — fall back to REST API via curl with explicit JSON body.
        // We bypass `gh api -f` because ghRestFallback (the curl fallback for
        // `gh api`) passes `-f` to curl as "fail on HTTP errors" instead of
        // converting it into a request-body field, silently dropping merge_method.
        console.warn("[scm-github] mergePR: rate limit hit on gh pr merge — falling back to REST API via curl");
        const token =
          process.env.GITHUB_TOKEN ??
          process.env.GH_TOKEN ??
          await getGhToken();
        if (!token) {
          throw new Error(
            "mergePR: rate limit hit and no GitHub token found in GITHUB_TOKEN, GH_TOKEN, or gh auth token for REST fallback",
            { cause: err },
          );
        }

        const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`;
        const body = JSON.stringify({ merge_method: method });

        try {
          await execFileAsync("curl", [
            "-sS",
            "-f",
            "-X",
            "PUT",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            `Authorization: Bearer ${token}`,
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            "-H",
            "Content-Type: application/json",
            "-d",
            body,
            url,
          ], {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30_000,
          });
        } catch (curlErr) {
          throw new Error(`mergePR REST fallback via curl failed: ${(curlErr as Error).message}`, {
            cause: curlErr,
          });
        }

        // gh pr merge --delete-branch deletes the head branch after merging.
        // Replicate that behaviour in the fallback path (best-effort; only possible
        // when the head repo matches the base repo to have write access).
        try {
          await gh(["api", `repos/${pr.owner}/${pr.repo}/git/refs/heads/${encodeURIComponent(pr.branch)}`, "--method", "DELETE"]);
        } catch {
          // Non-fatal: best-effort branch cleanup. Log and continue.
          console.warn(
            `mergePR: could not delete branch "${pr.branch}" after REST merge — ` +
              "this is non-fatal; the branch may be cleaned up manually or by repository settings",
          );
        }
      }
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const raw = await gh([
          "pr",
          "checks",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "name,state,link,startedAt,completedAt",
        ]);

        const checks: Array<{
          name: string;
          state: string;
          link: string;
          startedAt: string;
          completedAt: string;
        }> = JSON.parse(raw);

        return checks.map((c) => {
          const state = c.state?.toUpperCase();

          return {
            name: c.name,
            status: mapRawCheckStateToStatus(state),
            url: c.link || undefined,
            conclusion: state || undefined,
            startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
            completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
          };
        });
      } catch (err) {
        if (isUnsupportedPrChecksJsonError(err)) {
          return getCIChecksFromStatusRollup(pr);
        }
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch (err) {
        // Rate limit errors are transient — do not fail-close to "failing",
        // which would spam the agent with spurious "CI is failing" reactions.
        // Return "none" so the lifecycle poller retries next cycle.
        if (isRateLimitError(err)) {
          return "none";
        }
        // Before fail-closing, check if the PR is merged/closed —
        // GitHub may not return check data for those, and reporting
        // "failing" for a merged PR is wrong.
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Can't determine state either; fall through to fail-closed.
        }
        // Fail closed for open PRs: report as failing rather than
        // "none" (which getMergeability treats as passing).
        return "failing";
      }
      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      // Only report passing if at least one check actually passed
      // (not all skipped)
      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviews",
      ]);
      const data: {
        reviews: Array<{
          author: { login: string };
          state: string;
          body: string;
          submittedAt: string;
        }>;
      } = JSON.parse(raw);

      // REST API fallback doesn't include reviews — return empty
      if (!data.reviews) return [];

      return data.reviews.map((r) => {
        let state: Review["state"];
        const s = r.state?.toUpperCase();
        if (s === "APPROVED") state = "approved";
        else if (s === "CHANGES_REQUESTED") state = "changes_requested";
        else if (s === "DISMISSED") state = "dismissed";
        else if (s === "PENDING") state = "pending";
        else state = "commented";

        return {
          author: r.author?.login ?? "unknown",
          state,
          body: r.body || undefined,
          submittedAt: parseDate(r.submittedAt),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      let raw: string;
      try {
        raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "reviewDecision",
        ]);
      } catch (err) {
        // Rate limit errors are transient — return "none" so the lifecycle
        // poller retries next cycle rather than triggering a "changes-requested"
        // reaction on every poll.
        if (isRateLimitError(err)) {
          return "none";
        }
        throw err;
      }
      const data: { reviewDecision: string } = JSON.parse(raw);

      const d = (data.reviewDecision ?? "").toUpperCase();
      if (d === "APPROVED") return "approved";
      if (d === "CHANGES_REQUESTED") return "changes_requested";
      if (d === "REVIEW_REQUIRED") return "pending";
      return "none";
    },

    // bd-sm7: Combined PR state + review decision in a single gh CLI call
    async getPRStateAndReview(pr: PRInfo): Promise<{ state: PRState; reviewDecision: ReviewDecision }> {
      let raw: string;
      try {
        raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "state,reviewDecision",
        ]);
      } catch (err) {
        // Rate limits: rethrow so determineStatus preserves current session status for retry.
        if (isRateLimitError(err)) throw err;
        // Non-rate-limit errors: fall back to separate calls, which have their own
        // fail-closed handling. If the fallback itself hits a rate limit, rethrow so
        // the outer retry logic runs. Otherwise, return fail-closed values.
        try {
          const [state, reviewDecision] = await Promise.all([this.getPRState(pr), this.getReviewDecision(pr)]);
          return { state, reviewDecision };
        } catch (fallbackErr) {
          if (isRateLimitError(fallbackErr)) throw fallbackErr;
          // Fail closed: do not leave a stale "mergeable"/"approved" status.
          return { state: "open", reviewDecision: "pending" };
        }
      }
      const data: { state: string; reviewDecision?: string; merged?: boolean } = JSON.parse(raw);

      // Parse state (same logic as getPRState)
      const s = data.state.toUpperCase();
      let state: PRState;
      if (s === "MERGED" || data.merged === true) state = "merged";
      else if (s === "CLOSED") state = "closed";
      else state = "open";

      // Parse review decision — fail-closed: default to "pending" on unexpected values
      // (matches getReviewDecision behavior where non-rate-limit errors return "pending")
      const d = (data.reviewDecision ?? "").toUpperCase();
      let reviewDecision: ReviewDecision;
      if (d === "APPROVED") reviewDecision = "approved";
      else if (d === "CHANGES_REQUESTED") reviewDecision = "changes_requested";
      else if (d === "REVIEW_REQUIRED") reviewDecision = "pending";
      else reviewDecision = "none";

      return { state, reviewDecision };
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        // Use GraphQL with variables to get review threads with actual isResolved status
        const raw = await gh([
          "api",
          "graphql",
          "-f",
          `owner=${pr.owner}`,
          "-f",
          `name=${pr.repo}`,
          "-F",
          `number=${pr.number}`,
          "-f",
          `query=query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  nodes {
                    isResolved
                    comments(first: 1) {
                      nodes {
                        id
                        author { login }
                        body
                        path
                        line
                        url
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }`,
        ]);

        const data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array<{
                    isResolved: boolean;
                    comments: {
                      nodes: Array<{
                        id: string;
                        author: { login: string } | null;
                        body: string;
                        path: string | null;
                        line: number | null;
                        url: string;
                        createdAt: string;
                      }>;
                    };
                  }>;
                };
              };
            };
          };
        } = JSON.parse(raw);

        const threads = data.data.repository.pullRequest.reviewThreads.nodes;

        return threads
          .filter((t) => {
            if (t.isResolved) return false; // only pending (unresolved) threads
            const c = t.comments.nodes[0];
            if (!c) return false; // skip threads with no comments
            const author = c.author?.login ?? "";
            return !BOT_AUTHORS.has(author);
          })
          .map((t) => {
            const c = t.comments.nodes[0];
            return {
              id: c.id,
              author: c.author?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: t.isResolved,
              createdAt: parseDate(c.createdAt),
              url: c.url,
            };
          });
      } catch (err) {
        // REST fallback when GraphQL is rate-limited (bd-b02)
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!errMsg.includes("rate limit") && !errMsg.includes("RATE_LIMIT")) {
          throw new Error("Failed to fetch pending comments", { cause: err });
        }

        // Fallback: fetch inline review comments via REST (no isResolved field)
        const restComments: ReviewComment[] = [];
        try {
          const raw = await gh([
            "api",
            "--method",
            "GET",
            `repos/${repoFlag(pr)}/pulls/${pr.number}/comments?per_page=100`,
          ]);
          const parsed: Array<{
            id: number;
            user: { login: string };
            body: string;
            path: string;
            line: number | null;
            created_at: string;
            html_url: string;
          }> = JSON.parse(raw);

          for (const c of parsed) {
            if (BOT_AUTHORS.has(c.user.login)) continue;
            restComments.push({
              id: String(c.id),
              author: c.user.login,
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: false, // REST has no resolution state — treat as unresolved
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            });
          }
        } catch {
          // REST also failed — return empty rather than blocking merge gate
        }

        // Also fetch issue/conversation comments (bd-b02)
        try {
          const raw = await gh([
            "api",
            "--method",
            "GET",
            `repos/${repoFlag(pr)}/issues/${pr.number}/comments?per_page=100`,
          ]);
          const parsed: Array<{
            id: number;
            user: { login: string };
            body: string;
            created_at: string;
            html_url: string;
          }> = JSON.parse(raw);

          for (const c of parsed) {
            if (BOT_AUTHORS.has(c.user.login)) continue;
            // Only include actionable issue comments (not status updates)
            const actionable = /\b(fix|bug|issue|change|update|please|should|must|need)\b/i.test(
              c.body,
            );
            if (!actionable) continue;
            restComments.push({
              id: String(c.id),
              author: c.user.login,
              body: c.body,
              isResolved: false,
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            });
          }
        } catch {
          // Issue comments fetch failed — non-fatal
        }

        return restComments;
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const perPage = 100;
        const comments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          created_at: string;
          html_url: string;
        }> = [];

        for (let page = 1; ; page++) {
          const raw = await gh([
            "api",
            "--method",
            "GET",
            `repos/${repoFlag(pr)}/pulls/${pr.number}/comments?per_page=${perPage}&page=${page}`,
          ]);
          const pageComments: Array<{
            id: number;
            user: { login: string };
            body: string;
            path: string;
            line: number | null;
            original_line: number | null;
            created_at: string;
            html_url: string;
          }> = JSON.parse(raw);

          if (pageComments.length === 0) {
            break;
          }

          comments.push(...pageComments);
          if (pageComments.length < perPage) {
            break;
          }
        }

        return comments
          .filter((c) => BOT_AUTHORS.has(c.user?.login ?? ""))
          .map((c) => {
            // Determine severity from body content
            let severity: AutomatedComment["severity"] = "info";
            const bodyLower = c.body.toLowerCase();
            // Check for explicit severity headers first (Bugbot/Copilot style)
            const hasCriticalHeader = /\*\*(critical|high)\s+severity\*\*/i.test(c.body);
            const hasMediumHeader = /\*\*(medium|low)\s+severity\*\*/i.test(c.body);
            if (hasCriticalHeader && !hasMediumHeader) {
              // Explicit "Critical/High Severity" header from cursor[bot] or Copilot →
              // "warning" (not "error"). These are review-level severity flags, not build
              // errors. The Bugbot check-run conclusion (merge gate check #4) is the
              // authoritative signal for whether Bugbot considers the PR blocked; body
              // severity is a secondary filter that would otherwise create false
              // positives (e.g. "High Severity" in a description of an old bug).
              severity = "warning";
            } else if (hasMediumHeader) {
              severity = "warning";
            } else if (
              // Direct error reports (CI bots, build failures) — anchored to line-start
              // with optional leading whitespace (CI bots often indent). The \s* allows
              // indented messages like "  error:" while staying anchored to line-start.
              /^\s*error[:\s]/m.test(bodyLower) ||
              /^\s*critical[:\s]/m.test(bodyLower) ||
              bodyLower.includes("potential issue")
            ) {
              severity = "error";
            } else if (
              /^\s*warning[:\s]/m.test(bodyLower) ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            return {
              id: String(c.id),
              botName: c.user?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? c.original_line ?? undefined,
              severity,
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            };
          });
      } catch (err) {
        throw new Error("Failed to fetch automated comments", { cause: err });
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      // First, check if the PR is merged
      // GitHub returns mergeable=null for merged PRs, which is not useful
      // Note: We only skip checks for merged PRs. Closed PRs still need accurate status.
      const state = await this.getPRState(pr);
      if (state === "merged") {
        // For merged PRs, return a clean result without querying mergeable status
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      // Fetch PR details with merge state
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "mergeable,reviewDecision,mergeStateStatus,isDraft",
      ]);

      const data = JSON.parse(raw) as {
        mergeable: string | boolean | null;
        reviewDecision?: string;
        mergeStateStatus?: string;
        isDraft?: boolean;
        draft?: boolean;
        mergeable_state?: string;
      };

      normalizeMergePayloadFromRestShape(data as Record<string, unknown>);

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
      const approved = reviewDecision === "APPROVED";
      if (reviewDecision === "CHANGES_REQUESTED") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "REVIEW_REQUIRED") {
        blockers.push("Review required");
      }

      // Conflicts / merge state
      // GraphQL returns mergeable as string ("MERGEABLE"/"CONFLICTING"/"UNKNOWN")
      // REST API returns mergeable as boolean (true/false/null)
      let noConflicts: boolean;
      const mergeableVal = data.mergeable;
      if (mergeableVal === null || mergeableVal === undefined) {
        noConflicts = false;
        blockers.push("Merge status unknown (GitHub is computing)");
      } else if (typeof mergeableVal === "boolean") {
        noConflicts = mergeableVal;
        if (!mergeableVal) {
          blockers.push("Merge conflicts");
        }
      } else {
        const mergeable = String(mergeableVal ?? "").toUpperCase();
        if (mergeable === "NULL") {
          noConflicts = false;
          blockers.push("Merge status unknown (GitHub is computing)");
        } else {
          noConflicts = mergeable === "MERGEABLE";
          if (mergeable === "CONFLICTING") {
            blockers.push("Merge conflicts");
          } else if (mergeable === "UNKNOWN" || mergeable === "") {
            blockers.push("Merge status unknown (GitHub is computing)");
          }
        }
      }
      const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
      if (mergeState === "BEHIND") {
        blockers.push("Branch is behind base branch");
      } else if (mergeState === "BLOCKED") {
        blockers.push("Merge is blocked by branch protection");
      } else if (mergeState === "UNSTABLE") {
        blockers.push("Required checks are failing");
      }

      // Draft — GraphQL uses "isDraft", REST uses "draft"
      if (data.isDraft || data.draft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },

    // bd-att: Fetch all PR status fields in a single gh CLI call.
    // Replaces getPRState + getCISummary + getReviewDecision + getMergeability
    // with one `gh pr view --json` (~2 GraphQL points instead of ~10).
    async getBatchPRStatus(pr: PRInfo): Promise<BatchPRStatus> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,isDraft",
      ]);

      const data = JSON.parse(raw) as {
        state: string;
        merged?: boolean;
        reviewDecision?: string;
        statusCheckRollup?: unknown[];
        mergeable?: string | boolean | null;
        mergeStateStatus?: string;
        isDraft?: boolean;
        draft?: boolean;
        mergeable_state?: string;
      };

      // --- PR State ---
      const s = data.state.toUpperCase();
      let state: PRState;
      if (s === "MERGED" || data.merged === true) state = "merged";
      else if (s === "CLOSED") state = "closed";
      else state = "open";

      // Normalize REST-shape fields (mergeable_state, draft) before deriving typed fields.
      // Copilot: normalize first so reviewDecision undefined is treated as REVIEW_REQUIRED.
      normalizeMergePayloadFromRestShape(data as Record<string, unknown>);

      // --- Review Decision ---
      // Fail-closed: null/undefined reviewDecision → "pending" (not "none"), matching
      // normalizeMergePayloadFromRestShape behavior. "none" means reviews were explicitly
      // not required; null means we don't know → conservative.
      const d = (data.reviewDecision ?? "").toUpperCase();
      let reviewDecision: ReviewDecision;
      if (d === "APPROVED") reviewDecision = "approved";
      else if (d === "CHANGES_REQUESTED") reviewDecision = "changes_requested";
      else if (d === "REVIEW_REQUIRED") reviewDecision = "pending";
      else if (data.reviewDecision === null || data.reviewDecision === undefined) reviewDecision = "pending";
      else reviewDecision = "none";

      // --- CI Status (from statusCheckRollup) ---
      const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
      let ciStatus: CIStatus;
      if (rollup.length === 0) {
        ciStatus = "none";
      } else {
        const checks = rollup.map((entry) => {
          if (!entry || typeof entry !== "object") return "pending" as const;
          const row = entry as Record<string, unknown>;
          const rawState =
            typeof row["conclusion"] === "string"
              ? row["conclusion"]
              : typeof row["state"] === "string"
                ? row["state"]
                : typeof row["status"] === "string"
                  ? row["status"]
                  : undefined;
          return mapRawCheckStateToStatus(rawState);
        });
        const hasFailing = checks.some((c) => c === "failed");
        if (hasFailing) {
          ciStatus = "failing";
        } else {
          const hasPending = checks.some((c) => c === "pending" || c === "running");
          if (hasPending) {
            ciStatus = "pending";
          } else {
            const hasPassing = checks.some((c) => c === "passed");
            ciStatus = hasPassing ? "passing" : "none";
          }
        }
      }

      // --- Merge Readiness ---
      const blockers: string[] = [];

      // CI
      const ciPassing = ciStatus === "passing" || ciStatus === "none";
      if (!ciPassing) blockers.push(`CI is ${ciStatus}`);

      // Reviews
      const approved = reviewDecision === "approved";
      if (reviewDecision === "changes_requested") blockers.push("Changes requested in review");
      else if (reviewDecision === "pending") blockers.push("Review required");

      // Conflicts / merge state
      let noConflicts: boolean;
      const mergeableVal = data.mergeable;
      if (mergeableVal === null || mergeableVal === undefined) {
        noConflicts = false;
        blockers.push("Merge status unknown (GitHub is computing)");
      } else if (typeof mergeableVal === "boolean") {
        noConflicts = mergeableVal;
        if (!mergeableVal) blockers.push("Merge conflicts");
      } else {
        const mergeable = String(mergeableVal ?? "").toUpperCase();
        if (mergeable === "NULL") {
          noConflicts = false;
          blockers.push("Merge status unknown (GitHub is computing)");
        } else {
          noConflicts = mergeable === "MERGEABLE";
          if (mergeable === "CONFLICTING") blockers.push("Merge conflicts");
          else if (mergeable === "UNKNOWN" || mergeable === "") {
            blockers.push("Merge status unknown (GitHub is computing)");
          }
        }
      }
      const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
      if (mergeState === "BEHIND") blockers.push("Branch is behind base branch");
      else if (mergeState === "BLOCKED") blockers.push("Merge is blocked by branch protection");
      else if (mergeState === "UNSTABLE") blockers.push("Required checks are failing");

      if (data.isDraft || data.draft) blockers.push("PR is still a draft");

      return {
        state,
        ciStatus,
        reviewDecision,
        mergeReadiness: {
          mergeable: blockers.length === 0,
          ciPassing,
          approved,
          noConflicts,
          blockers,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): SCM {
  return createGitHubSCM(config);
}

export { _resetGhCache } from "./gh-cache.js";

export default { manifest, create } satisfies PluginModule<SCM>;
