/**
 * CI Failure Context — companion module for upstream commit 3fb23cfb4.
 *
 * Extracts CI failure injection logic from lifecycle-manager.ts into an
 * isolated module to minimize the fork diff on that hot surface.
 *
 * Provides:
 * - formatCIFailureMessage: build an actionable CI failure message using
 *   SCM-provided job/step/log details when available, falling back to
 *   check names/links.
 * - getFailedCIChecks: deduplicated CI failure check lookup.
 * - makeCIFailureFingerprint: stable fingerprint for dispatch dedup.
 * - enrichCIFailureReaction: one-line call to enrich a ci-failed reaction
 *   config with detailed failure context before dispatch.
 */

import type { SCM, CICheck, CIFailureSummary, PRInfo, ReactionConfig } from "./types.js";

export function isFailedCICheck(check: CICheck): boolean {
  return check.status === "failed" || check.conclusion?.toUpperCase() === "FAILURE";
}

export function escapeMarkdownCodeFenceClosers(logTail: string): string {
  return logTail
    .split(/\r?\n/)
    .map((line) => (/^[ \t]{0,3}```/.test(line) ? `\u200B${line}` : line))
    .join("\n");
}

function formatCIFailureSummaryMessage(summary: CIFailureSummary): string {
  const lines = ["CI is failing on your PR.", ""];

  for (const job of summary.failedJobs) {
    const failed = job.failedStep ? `${job.name} → ${job.failedStep}` : job.name;
    lines.push(`Failed: ${failed}`);
    lines.push(`Failure URL: ${job.runUrl}`);

    if (job.logTail) {
      const lineCount = job.logTail.split(/\r?\n/).length;
      const lineLabel = lineCount === 1 ? "line" : "lines";
      const escapedTail = escapeMarkdownCodeFenceClosers(job.logTail);
      lines.push("", `Log tail (last ${lineCount} ${lineLabel}):`, "```", escapedTail, "```");
    }

    lines.push("");
  }

  lines.push("Fix the issues and push again.");
  return lines.join("\n");
}

function formatCIFailureChecksFallback(failedChecks: CICheck[]): string {
  const lines = ["CI checks are failing on your PR. Here are the failed checks:", ""];
  for (const check of failedChecks) {
    const status = check.conclusion ?? check.status;
    const url = check.url ? ` (${check.url})` : "";
    lines.push(`- **${check.name}**: ${status}${url}`);
  }
  lines.push("", "Fix the issues and push again.");
  return lines.join("\n");
}

const CI_CONTEXT_TIMEOUT_MS = 10_000;

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = CI_CONTEXT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CI context timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function formatCIFailureMessage(
  scm: SCM,
  pr: PRInfo,
  failedChecks: CICheck[],
): Promise<string> {
  if (scm.getCIFailureSummary) {
    try {
      const summary = await withTimeout(scm.getCIFailureSummary(pr, failedChecks));
      if (summary?.failedJobs.length) {
        const enrichedNames = summary.failedJobs.map((j) => j.name);
        const enrichedNameCounts = new Map<string, number>();
        for (const n of enrichedNames) enrichedNameCounts.set(n, (enrichedNameCounts.get(n) ?? 0) + 1);
        const remaining: CICheck[] = [];
        const seenEnriched = new Map<string, number>();
        for (const c of failedChecks) {
          const enrichedCount = enrichedNameCounts.get(c.name) ?? 0;
          if (enrichedCount > 0) {
            const alreadyKept = seenEnriched.get(c.name) ?? 0;
            if (alreadyKept < enrichedCount) {
              seenEnriched.set(c.name, alreadyKept + 1);
            } else {
              remaining.push(c);
            }
          } else {
            remaining.push(c);
          }
        }
        if (remaining.length === 0) {
          return formatCIFailureSummaryMessage(summary);
        }
        const summaryPart = formatCIFailureSummaryMessage(summary);
        const fallbackPart = formatCIFailureChecksFallback(remaining);
        return `${summaryPart}\n\n---\n\nAdditional failing checks:\n\n${fallbackPart}`;
      }
    } catch {
      // Fall back to check names when summary enrichment fails.
    }
  }

  return formatCIFailureChecksFallback(failedChecks);
}

export async function getFailedCIChecks(
  scm: SCM,
  pr: PRInfo,
  options: { allowFetch: boolean },
): Promise<CICheck[] | null> {
  let checks: CICheck[] | undefined;
  if (options.allowFetch) {
    try {
      checks = await withTimeout(scm.getCIChecks(pr));
    } catch {
      return null;
    }
  }

  const failedChecks = checks?.filter(isFailedCICheck) ?? [];
  return failedChecks.length > 0 ? failedChecks : null;
}

export function makeCIFailureFingerprint(failedChecks: CICheck[]): string {
  return [...failedChecks]
    .map((c) => `${c.name}:${c.status}:${c.conclusion ?? ""}`)
    .sort((a, b) => a.localeCompare(b))
    .join("|");
}

export async function enrichCIFailureReaction(
  scm: SCM,
  pr: PRInfo,
  reactionConfig: ReactionConfig,
  allowFetch: boolean,
): Promise<{ config: ReactionConfig; enriched: boolean }> {
  const failedChecks = await getFailedCIChecks(scm, pr, { allowFetch });
  if (!failedChecks) {
    const fallbackMessage =
      "CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.";
    const baseMessage = reactionConfig.message
      ? reactionConfig.message.replace(/\{\{context\}\}/g, fallbackMessage)
      : fallbackMessage;
    return {
      config: { ...reactionConfig, message: baseMessage },
      enriched: false,
    };
  }

  const ciMessage = await formatCIFailureMessage(scm, pr, failedChecks);
  const baseMessage = reactionConfig.message;
  const mergedMessage = baseMessage
    ? (baseMessage.includes("{{context}}")
      ? baseMessage.replace(/\{\{context\}\}/g, () => ciMessage)
      : `${baseMessage}\n\n${ciMessage}`)
    : ciMessage;
  return {
    config: { ...reactionConfig, message: mergedMessage },
    enriched: true,
  };
}
