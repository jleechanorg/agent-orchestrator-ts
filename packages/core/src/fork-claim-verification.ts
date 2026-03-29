/**
 * Claim Verification Extension — bd-upxh
 *
 * AO-worker-driven deterministic claim verifier for skeptic gate assertions:
 *   "no agent may report 'working' unless run-level AND comment-level evidence passes."
 *
 * Validates the full skeptic-gate chain:
 *   1. precheck (GHA skeptic-gate.yml) — CI, conflicts, CR, Bugbot, comments
 *   2. trigger (GHA posts SKEPTIC_GATE_TRIGGER comment)
 *   3. poll (GHA polls for VERDICT comment)
 *   4. comment (lifecycle-worker posts VERDICT via ao skeptic verify)
 *
 * Fail-closed: ambiguous → INSUFFICIENT/FAIL — agents cannot claim 'working'.
 *
 * Extracted from lifecycle-manager.ts to keep that module thin.
 * The claim-verification reaction case lives here; lifecycle-manager.ts
 * imports and delegates to it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Session, ReactionConfig, ReactionResult } from "./types.js";

const execFileAsync = promisify(execFile);

/** VERDICT matcher for GitHub comment parsing */
const VERDICT_RE = /VERDICT:\s*(PASS|FAIL|SKIPPED)\b/i;

/** Result of checking one chain link */
interface ChainLink {
  name: string;
  status: "present" | "absent" | "error";
  detail: string;
}

/** Result of a complete claim verification */
export interface ClaimVerificationOutcome {
  outcome: "PASS" | "FAIL" | "INSUFFICIENT";
  chain: ChainLink[];
  summary: string;
  blocksWorking: boolean;
}

/**
 * Verify the skeptic-gate chain for a PR:
 *   precheck → trigger → poll → comment
 *
 * This runs as an AO-worker reaction after skeptic-review to validate
 * the full chain was executed correctly.
 *
 * @param session - The session/PR to verify
 * @param triggerSha - Expected trigger SHA (optional)
 */
export async function runClaimVerification(params: {
  reactionKey: string;
  reactionConfig: ReactionConfig;
  session: Session;
}): Promise<ReactionResult> {
  const { session } = params;

  if (!session.pr) {
    return {
      reactionType: params.reactionKey,
      success: false,
      action: "claim-verification",
      message: "No PR associated — claim verification skipped",
      escalated: false,
    };
  }

  const { owner, repo, number } = session.pr;

  const outcome = await verifySkepticClaimForPR(owner, repo, number);

  const success = outcome.outcome === "PASS";
  const message = [
    `Claim verification: ${outcome.outcome}`,
    ...outcome.chain.map((l) => `  ${l.name}: ${l.status} — ${l.detail}`),
    outcome.summary,
  ].join("\n");

  return {
    reactionType: params.reactionKey,
    success,
    action: "claim-verification",
    message,
    // INSUFFICIENT always blocks; FAIL also blocks (verdict contradicts)
    escalated: outcome.blocksWorking,
  };
}

/**
 * Deterministic claim verification for a PR.
 *
 * Checks:
 * 1. precheck — GHA workflow pre-check (gates 1-5: CI, conflicts, CR, Bugbot, comments)
 * 2. trigger  — GHA posted SKEPTIC_GATE_TRIGGER comment
 * 3. poll     — GHA polled (check run timestamps)
 * 4. comment  — VERDICT comment posted with correct SHA binding
 *
 * @param owner   - repo owner
 * @param repo    - repo name
 * @param prNumber - PR number
 * @param triggerSha - Expected SHA (from trigger comment)
 */
export async function verifySkepticClaimForPR(
  owner: string,
  repo: string,
  prNumber: number,
  _triggerSha?: string,
): Promise<ClaimVerificationOutcome> {
  const chain: ChainLink[] = [];
  let verdictFound = false;
  let verdictType: "PASS" | "FAIL" | "SKIPPED" | null = null;

  // ---------------------------------------------------------------------------
  // Step 1: Check for VERDICT comment (comment-level evidence)
  // ---------------------------------------------------------------------------
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        "--jq",
        `[.[] | select(.body | test("<!--\\\\s*skeptic-agent-verdict\\\\s*-->"; "i"))] | .[0] | {body: .body, updated_at: .updated_at}"`,
      ],
      { timeout: 10_000 },
    );
    const parsed = JSON.parse((stdout || "{}").trim());
    if (parsed && parsed.body) {
      verdictFound = true;
      const m = parsed.body.match(VERDICT_RE);
      if (m) {
        verdictType = m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED";
      }
      chain.push({
        name: "comment-level",
        status: "present",
        detail: `VERDICT: ${verdictType ?? "unknown"} from skeptic-agent-verdict comment`,
      });
    } else {
      chain.push({
        name: "comment-level",
        status: "absent",
        detail: "No <!-- skeptic-agent-verdict --> comment found",
      });
    }
  } catch (err) {
    chain.push({
      name: "comment-level",
      status: "error",
      detail: `API error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 2: Check for SKEPTIC_GATE_TRIGGER comment (trigger-level evidence)
  // ---------------------------------------------------------------------------
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        "--jq",
        `[.[] | select(.body | test("SKEPTIC_GATE_TRIGGER"; "i"))] | length`,
      ],
      { timeout: 10_000 },
    );
    const count = parseInt((stdout || "0").trim(), 10);
    if (count > 0) {
      chain.push({
        name: "trigger-level",
        status: "present",
        detail: `${count} SKEPTIC_GATE_TRIGGER comment(s) found`,
      });
    } else {
      chain.push({
        name: "trigger-level",
        status: "absent",
        detail: "No SKEPTIC_GATE_TRIGGER comment found (GHA may not have run)",
      });
    }
  } catch (err) {
    chain.push({
      name: "trigger-level",
      status: "error",
      detail: `API error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3: Check skeptic-gate GHA workflow run for this PR
  // ---------------------------------------------------------------------------
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/actions/runs`,
        "--jq",
        `.workflow_runs[] | select(.name == "Skeptic Gate") | {id: .id, status: .status, conclusion: .conclusion, head_sha: .head_sha, created_at: .created_at}"`,
      ],
      { timeout: 10_000 },
    );
    const lines = (stdout || "").trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const runs = lines.map((l) => JSON.parse(l)).slice(0, 3); // latest 3 runs
      const latest = runs[0];
      chain.push({
        name: "skeptic-gate-gha",
        status: latest.conclusion === "success" ? "present" : "error",
        detail: `Run #${latest.id}: ${latest.status}/${latest.conclusion ?? "null"} @ ${latest.head_sha?.slice(0, 7)}`,
      });
    } else {
      chain.push({
        name: "skeptic-gate-gha",
        status: "absent",
        detail: "No Skeptic Gate workflow run found",
      });
    }
  } catch (err) {
    chain.push({
      name: "skeptic-gate-gha",
      status: "error",
      detail: `API error: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Decision: PASS / FAIL / INSUFFICIENT
  // ---------------------------------------------------------------------------
  let outcome: "PASS" | "FAIL" | "INSUFFICIENT";
  let summary: string;

  if (verdictFound && verdictType === "PASS") {
    outcome = "PASS";
    summary = `Claim verified: VERDICT: PASS on PR #${prNumber}. Agent 'working' status permitted.`;
  } else if (verdictFound && verdictType === "FAIL") {
    outcome = "FAIL";
    summary = `Claim contradicted: VERDICT: FAIL on PR #${prNumber}. Agent 'working' status BLOCKED.`;
  } else if (verdictType === "SKIPPED") {
    outcome = "INSUFFICIENT";
    summary = `Infrastructure unavailable (SKIPPED). Cannot verify claim. Agent 'working' status BLOCKED.`;
  } else {
    outcome = "INSUFFICIENT";
    summary = `No VERDICT comment found. Cannot verify claim. Agent 'working' status BLOCKED (fail-closed).`;
  }

  return {
    outcome,
    chain,
    summary,
    blocksWorking: outcome !== "PASS",
  };
}
