/**
 * Skeptic context helpers — bd-qqm skeptic-advice reaction.
 *
 * Extracted from reaction-context.ts per CR review: keeps the core upstream
 * file thin and isolates fork-only behavior in a companion module.
 */

import type { SCM, Session } from "./types.js";

/**
 * Extract structured sections from a skeptic FAIL comment body.
 * The skeptic agent posts comments with ## Background, ## Current Problem,
 * and ## Recommended Solution sections. Returns the extracted content.
 */
export function extractSkepticSections(body: string): string {
  const sections: string[] = [];

  const background = extractSection(body, "Background");
  if (background) sections.push(`## Background\n${background}`);

  const problem = extractSection(body, "Current Problem");
  if (problem) sections.push(`## Current Problem\n${problem}`);

  const solution = extractSection(body, "Recommended Solution");
  if (solution) sections.push(`## Recommended Solution\n${solution}`);

  // Fall back to raw body if no sections found
  if (sections.length === 0) {
    return body.slice(0, 2000);
  }

  return sections.join("\n\n");
}

/** Extract the content between a ## Section header and the next ## header or end of string. */
function extractSection(body: string, sectionName: string): string | null {
  // Split body by ## headers, find the named section, return its content.
  const parts = body.split(/(?=##\s+)/i);
  const prefix = `## ${sectionName}`;
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      const afterHeader = part.slice(prefix.length).replace(/^\r?\n/, "");
      return afterHeader.trimEnd() || null;
    }
  }
  return null;
}

/**
 * Build skeptic-advice reaction context for a session.
 * Fetches skeptic agent comments on the PR and extracts structured sections
 * from the most recent FAIL verdict.
 */
export async function buildSkepticAdviceContext(
  scm: SCM,
  session: Session,
): Promise<string> {
  if (!scm.getSkepticComments) return "";
  const comments = await scm.getSkepticComments(session.pr!);
  // Find the latest FAIL verdict comment
  let latestFail: { id: number; body: string } | null = null;
  for (const c of comments) {
    if (/VERDICT:\s*FAIL/i.test(c.body) && c.id > (latestFail?.id ?? -1)) {
      latestFail = { id: c.id, body: c.body };
    }
  }
  if (!latestFail) return "";
  return extractSkepticSections(latestFail.body);
}
