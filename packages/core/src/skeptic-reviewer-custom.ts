/**
 * Custom shell-harness reviewer support for skeptic-reviewer.ts (bd-skp2 follow-on,
 * PR #752 "support project-level custom reviewers").
 *
 * Extracted into its own module per the fork-isolation policy (large additions
 * should go into a companion module rather than growing an already-oversized
 * core file in place) — see packages/core/src/skeptic-reviewer.ts for the
 * built-in codex/claude/gemini fallback chain this complements.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type Session, type ReviewerConfig } from "./types.js";
import {
  hasVerdictInError,
  extractVerdictFromError,
  lastVerdictIn,
  SKEPTIC_VERIFY_TIMEOUT_MS,
  type SkepticReviewResult,
} from "./skeptic-reviewer.js";

const execFileAsync = promisify(execFile);

/**
 * Run a custom reviewer command using the shell harness.
 */
export async function runCustomReviewer(
  session: Session,
  reviewer: ReviewerConfig,
  triggerSha: string | undefined,
  requestId: string | undefined,
  postComment: boolean,
): Promise<SkepticReviewResult> {
  if (reviewer.harness !== "shell") {
    throw new Error(`Unsupported reviewer harness: ${reviewer.harness}`);
  }

  const rawCmd = reviewer.cmd ?? [];
  if (rawCmd.length === 0) {
    throw new Error("Empty command for custom reviewer");
  }

  const prNumber = session.pr!.number;
  const repo = `${session.pr!.owner}/${session.pr!.repo}`;

  let cmdArgs = rawCmd.map((arg) => {
    let replaced = arg;
    replaced = replaced.replace(/\{pr_number\}/g, String(prNumber));
    replaced = replaced.replace(/\{repo\}/g, repo);
    if (triggerSha) {
      replaced = replaced.replace(/\{trigger_sha\}/g, triggerSha);
      replaced = replaced.replace(/\{head_sha\}/g, triggerSha);
    } else {
      replaced = replaced.replace(/\{trigger_sha\}/g, "");
      replaced = replaced.replace(/\{head_sha\}/g, "");
    }
    if (requestId) {
      replaced = replaced.replace(/\{request_id\}/g, requestId);
    } else {
      replaced = replaced.replace(/\{request_id\}/g, "");
    }
    replaced = replaced.replace(/\{dry_run\}/g, postComment ? "" : "--dry-run");
    return replaced;
  });

  // Filter out arguments resulting from empty optional placeholders. A
  // standalone placeholder token (e.g. "{trigger_sha}") that resolves to ""
  // is dropped entirely; a preceding bare flag it was the value for (e.g.
  // "--sha") is dropped too, so it doesn't dangle with no value and get the
  // next positional argument consumed in its place. Config authors can avoid
  // this class of substitution entirely by using the combined form
  // "--sha={trigger_sha}", which degrades to a single well-formed "--sha="
  // token instead of two separate tokens (see agent-orchestrator.yaml.example).
  const isEmptyPlaceholder = (arg: string, original: string | undefined) =>
    arg === "" &&
    (original === "{dry_run}" ||
      original === "{trigger_sha}" ||
      original === "{head_sha}" ||
      original === "{request_id}");

  const dropIndices = new Set<number>();
  for (let i = 0; i < cmdArgs.length; i++) {
    if (!isEmptyPlaceholder(cmdArgs[i], rawCmd[i])) continue;
    dropIndices.add(i);
    const prev = cmdArgs[i - 1];
    if (
      i > 0 &&
      typeof prev === "string" &&
      prev.startsWith("-") &&
      !prev.includes("=") &&
      !dropIndices.has(i - 1)
    ) {
      dropIndices.add(i - 1);
    }
  }
  cmdArgs = cmdArgs.filter((_, index) => !dropIndices.has(index));

  let binary = cmdArgs[0];
  const args = cmdArgs.slice(1);

  if (binary === "ao") {
    binary = process.env["AO_CLI_PATH"] ?? "ao";
  }

  const env = {
    ...process.env,
    ...(reviewer.env || {}),
  };

  const cwd = session.workspacePath ?? process.env["AO_REPO_ROOT"] ?? process.cwd();

  const modelName = `shell:${cmdArgs.slice(0, 3).join(" ")}`;

  let output: string;
  try {
    const execResult = await execFileAsync(binary, args, {
      timeout: SKEPTIC_VERIFY_TIMEOUT_MS,
      cwd,
      env,
    });
    output = execResult.stdout + (execResult.stderr || "");
  } catch (err: unknown) {
    if (hasVerdictInError(err)) {
      return extractVerdictFromError(err, modelName);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Reviewer command failed: ${msg}`, { cause: err });
  }

  const verdict: "PASS" | "FAIL" | "SKIPPED" = lastVerdictIn(output) ?? "FAIL";

  return {
    verdict,
    details: output.slice(0, 500),
    modelUsed: modelName,
  };
}
