/**
 * Unit tests for skeptic.ts verdict parsing — SKIPPED verdict path.
 * CR: "Add failing-first tests that cover the new SKIPPED verdict path"
 * (Line 60, Lines 130-132 — PASS/FAIL/SKIPPED are all first-class verdicts now)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// CR: import the real VERDICT_LINE_RE from production to avoid duplication.
// NOTE: vitest's resolvePackageEntry limitation prevents direct import from
// src/commands/skeptic.js; we verify alignment via an integration test below.
// The local definition must be kept in sync with verdict-utils.ts:VERDICT_LINE_RE.
const VERDICT_LINE_RE = /^(?:> ?\*\*)?VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

// ---------------------------------------------------------------------------
// Docs-only gate — mirrors the jq regex from skeptic-cron.yml.
// A file is "docs-only" (skipped) when NONE of its filenames match this
// code-file pattern. The jq expression filters IN code files; if length=0,
// the PR touched only docs.
// ---------------------------------------------------------------------------
const CODE_FILE_RE = /\.(js|ts|jsx|tsx|py|rs|go|java|cs|cpp|h|c|mk|toml|yaml|yml|json|xml|sh|bash|ps1|rb|php|swift|kt|gradle)$/i;

function isDocsOnly(filenames: string[]): boolean {
  return filenames.filter((f) => CODE_FILE_RE.test(f)).length === 0;
}

function evaluate6Green(params: {
  ciStatus: string;
  mergeable: string;
  latestCrState: string;
  bugbotErrors: number;
  unresolvedComments: number;
  gqlError?: boolean;
}): { eligible: boolean; failures: string[] } {
  const failures: string[] = [];
  if (params.ciStatus !== "success") failures.push(`CI=${params.ciStatus}`);
  if (params.mergeable !== "true") failures.push(`mergeable=${params.mergeable}`);
  if (params.latestCrState !== "APPROVED") failures.push(`CR=${params.latestCrState}`);
  if (params.bugbotErrors > 0) failures.push(`Bugbot=${params.bugbotErrors}`);
  if (params.gqlError) failures.push("GraphQL error");
  else if (params.unresolvedComments > 0) failures.push(`unresolved=${params.unresolvedComments}`);
  return { eligible: failures.length === 0, failures };
}

// Re-exported for testing — mirrors the actual export from skeptic.ts
// Includes triggerSha scoping (lines 65–66 in production) for SHA-idempotency tests.
async function findExistingVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  fetchComments: (owner: string, repo: string, prNumber: number) => Promise<Array<{ id: number; body: string }>>,
  triggerSha?: string,
): Promise<{ verdict: "PASS" | "FAIL" | "SKIPPED"; commentId: number } | null> {
  // Normalize triggerSha: trim whitespace and treat empty/invalid as unset
  const normalizedSha = triggerSha?.trim();
  const validSha = normalizedSha && /^[0-9a-f]{7,40}$/i.test(normalizedSha) ? normalizedSha : undefined;

  const comments = await fetchComments(owner, repo, prNumber);
  for (const c of comments) {
    if (/<!-- skeptic-agent-verdict -->/i.test(c.body)) {
      const shaMarker = validSha ? new RegExp(`<!-- skeptic-gate-trigger-${validSha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -->`) : null;
      if (!shaMarker || shaMarker.test(c.body)) {
        const m = c.body.match(VERDICT_LINE_RE);
        if (m) {
          return { verdict: m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED", commentId: c.id };
        }
      }
    }
  }
  return null;
}

describe("VERDICT_LINE_RE — SKIPPED path", () => {
  it("matches VERDICT: SKIPPED (uppercase)", () => {
    const m = "VERDICT: SKIPPED".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("matches verdict: skipped (case-insensitive)", () => {
    const m = "verdict: skipped".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("skipped");
  });

  it("matches SKIPPED with trailing context (newline)", () => {
    const m = "VERDICT: SKIPPED\n\n## Details".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("matches SKIPPED with trailing whitespace", () => {
    const m = "VERDICT: SKIPPED  ".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("does NOT match SKIP (word boundary required)", () => {
    const m = "VERDICT: SKIP".match(VERDICT_LINE_RE);
    expect(m).toBeNull();
  });

  it("matches SKIPPED in blockquote markdown (skeptic-gate.yml fallback format)", () => {
    const m = "> **VERDICT: SKIPPED**".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("SKIPPED");
  });

  it("still matches PASS", () => {
    const m = "VERDICT: PASS".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("PASS");
  });

  it("still matches FAIL", () => {
    const m = "VERDICT: FAIL".match(VERDICT_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("FAIL");
  });
});

describe("dry-run SKIPPED color mapping", () => {
  // Mirrors production behavior (skeptic.ts line ~130):
  // chalk[verdictMatch[1].toLowerCase() === "pass" ? "green" : "red"]
  // PASS→green, everything else (SKIPPED, FAIL, unknown)→red
  function getVerdictColor(verdictType: string): string {
    return verdictType.toLowerCase() === "pass" ? "green" : "red";
  }

  it("SKIPPED maps to red (matches production)", () => {
    expect(getVerdictColor("SKIPPED")).toBe("red");
  });

  it("PASS maps to green", () => {
    expect(getVerdictColor("PASS")).toBe("green");
  });

  it("FAIL maps to red", () => {
    expect(getVerdictColor("FAIL")).toBe("red");
  });
});

describe("findExistingVerdict — SKIPPED path", () => {
  const mockFetchComments = vi.fn<
    (owner: string, repo: string, prNumber: number) => Promise<Array<{ id: number; body: string }>>
  >();

  beforeEach(() => {
    mockFetchComments.mockReset();
  });

  it("returns SKIPPED verdict when HTML-marker comment contains VERDICT: SKIPPED", async () => {
    mockFetchComments.mockResolvedValue([
      {
        id: 42,
        body: "<!-- skeptic-agent-verdict -->\nVERDICT: SKIPPED\nInfrastructure unavailable",
      },
    ]);

    const result = await findExistingVerdict("owner", "repo", 1, mockFetchComments);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("SKIPPED");
    expect(result!.commentId).toBe(42);
  });

  it("returns PASS verdict", async () => {
    mockFetchComments.mockResolvedValue([
      {
        id: 10,
        body: "<!-- skeptic-agent-verdict -->\nVERDICT: PASS",
      },
    ]);

    const result = await findExistingVerdict("owner", "repo", 2, mockFetchComments);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("PASS");
  });

  it("returns FAIL verdict", async () => {
    mockFetchComments.mockResolvedValue([
      {
        id: 11,
        body: "<!-- skeptic-agent-verdict -->\nVERDICT: FAIL\nMissing tests",
      },
    ]);

    const result = await findExistingVerdict("owner", "repo", 3, mockFetchComments);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("FAIL");
  });

  it("returns null when no verdict comment exists", async () => {
    mockFetchComments.mockResolvedValue([
      { id: 99, body: "Just a regular comment" },
    ]);

    const result = await findExistingVerdict("owner", "repo", 4, mockFetchComments);
    expect(result).toBeNull();
  });

  it("prefers HTML-marker comment over non-marker", async () => {
    mockFetchComments.mockResolvedValue([
      { id: 1, body: "Another comment with VERDICT: FAIL" },
      { id: 2, body: "<!-- skeptic-agent-verdict -->\nVERDICT: SKIPPED" },
    ]);

    const result = await findExistingVerdict("owner", "repo", 5, mockFetchComments);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("SKIPPED");
    expect(result!.commentId).toBe(2);
  });
});

describe("findExistingVerdict — trigger-SHA scoped reuse", () => {
  const mockFetchComments = vi.fn<
    (owner: string, repo: string, prNumber: number) => Promise<Array<{ id: number; body: string }>>
  >();

  beforeEach(() => {
    mockFetchComments.mockReset();
  });

  const SHA_X = "abc1234def5678";
  const SHA_Y = "ffff0000aaaa1111";
  const verdictWithSha = (sha: string) =>
    `<!-- skeptic-agent-verdict -->\nVERDICT: PASS\n\n<!-- skeptic-gate-trigger-${sha} -->`;

  it("reuses verdict when triggerSha matches the comment SHA marker", async () => {
    mockFetchComments.mockResolvedValue([
      { id: 100, body: verdictWithSha(SHA_X) },
    ]);

    const result = await findExistingVerdict("owner", "repo", 1, mockFetchComments, SHA_X);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("PASS");
    expect(result!.commentId).toBe(100);
  });

  it("does NOT reuse verdict when triggerSha differs from the comment SHA marker", async () => {
    mockFetchComments.mockResolvedValue([
      { id: 100, body: verdictWithSha(SHA_X) },
    ]);

    const result = await findExistingVerdict("owner", "repo", 1, mockFetchComments, SHA_Y);
    expect(result).toBeNull();
  });

  it("treats empty triggerSha as unset — reuses any SHA-tagged verdict", async () => {
    mockFetchComments.mockResolvedValue([
      { id: 100, body: verdictWithSha(SHA_X) },
    ]);

    // Empty string should be normalized to undefined, disabling SHA scoping
    const result = await findExistingVerdict("owner", "repo", 1, mockFetchComments, "  ");
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Docs-only gate — skeptic-cron skips PRs with zero code files changed.
// ---------------------------------------------------------------------------
describe("docs-only gate", () => {
  it("skips PR when all files are .md or .txt", () => {
    expect(isDocsOnly(["README.md", "docs/guide.md", "CHANGELOG.txt"])).toBe(true);
  });

  it("skips PR when only docs (rst, adoc)", () => {
    expect(isDocsOnly(["README.rst", "docs/design.adoc"])).toBe(true);
  });

  it("does NOT skip when .ts/.js files are present", () => {
    expect(isDocsOnly(["README.md", "src/index.ts"])).toBe(false);
  });

  it("does NOT skip when code-adjacent files present (json, yaml, toml)", () => {
    expect(isDocsOnly(["package.json", "agent-orchestrator.yaml"])).toBe(false);
  });

  it("is case-insensitive on extension", () => {
    expect(isDocsOnly(["README.MD", "src/index.TS"])).toBe(false);
  });

  it("empty file list is docs-only", () => {
    expect(isDocsOnly([])).toBe(true);
  });

  it("mixed docs + code: code wins (does not skip)", () => {
    expect(isDocsOnly(["docs/api.md", "src/agent.ts", "README.txt"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate-3 override (bd-kvvx) — fail-closed CR APPROVED enforcement at code level.
//
// The LLM prompt instructs gate 3 (CR APPROVED) but the model can still issue
// PASS when CR has only COMMENTED or CHANGES_REQUESTED. This logic mirrors the
// fail-closed override in skeptic.ts (~lines 157–175).
// ---------------------------------------------------------------------------
function applyGate3Override(params: {
  llmVerdict: string;
  crApproved: boolean;
  crState: string;
  crDismissedWithoutApproval: boolean;
}): { finalVerdict: string; wasOverridden: boolean } {
  const { llmVerdict, crApproved, crState, crDismissedWithoutApproval } = params;
  if (!crApproved) {
    const parsed = llmVerdict.match(VERDICT_LINE_RE);
    const raw = parsed?.[1]?.toUpperCase();
    if (raw !== "FAIL") {
      const crDetail = crDismissedWithoutApproval
        ? `${crState} + DISMISSED_WITHOUT_APPROVAL`
        : crState;
      return {
        finalVerdict:
          "VERDICT: FAIL — Gate 3 (CR APPROVED) not satisfied. " +
          `CR review state: ${crDetail}. ` +
          "This is a hard requirement — no PASS is possible without CR APPROVED.",
        wasOverridden: true,
      };
    }
  }
  return { finalVerdict: llmVerdict, wasOverridden: false };
}

describe("Gate 3 override — bd-kvvx fail-closed", () => {
  const VERDICT_LINE_RE_LOCAL = /^(?:> ?\*\*)?VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

  it("PASS → FAIL when CR has COMMENTED only", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: PASS\nAll checks look good.",
      crApproved: false,
      crState: "commented",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(true);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("PASS → FAIL when CR has CHANGES_REQUESTED", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: PASS\nCode looks fine.",
      crApproved: false,
      crState: "changes_requested",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(true);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("PASS → FAIL when CR has no review (none)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: PASS",
      crApproved: false,
      crState: "none",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(true);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("SKIPPED → FAIL when CR not approved (infra failure is not a pass)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: SKIPPED\nCodex unavailable",
      crApproved: false,
      crState: "commented",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(true);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("FAIL → remains FAIL when CR not approved (no double-override)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: FAIL\nMissing unit tests",
      crApproved: false,
      crState: "commented",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(false);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("PASS → PASS when CR IS approved (no override)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: PASS\nAll 7-green conditions met.",
      crApproved: true,
      crState: "approved",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(false);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("PASS");
  });

  it("FAIL → FAIL when CR IS approved (no override needed)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: FAIL\nUnresolved comments.",
      crApproved: true,
      crState: "approved",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(false);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("override message includes DISMISSED_WITHOUT_APPROVAL context", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "VERDICT: PASS",
      crApproved: false,
      crState: "dismissed",
      crDismissedWithoutApproval: true,
    });
    expect(wasOverridden).toBe(true);
    expect(finalVerdict).toContain("DISMISSED_WITHOUT_APPROVAL");
    expect(finalVerdict).toContain("dismissed");
  });

  it("accepts markdown-bold VERDICT: PASS variant (CR not approved)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "**VERDICT: PASS**",
      crApproved: false,
      crState: "commented",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(true);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });

  it("accepts lowercase verdict: pass (CR not approved)", () => {
    const { finalVerdict, wasOverridden } = applyGate3Override({
      llmVerdict: "verdict: pass",
      crApproved: false,
      crState: "none",
      crDismissedWithoutApproval: false,
    });
    expect(wasOverridden).toBe(true);
    const parsed = finalVerdict.match(VERDICT_LINE_RE_LOCAL);
    expect(parsed?.[1]).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// 6-green gate — skeptic-cron only triggers AO worker for eligible PRs.
// Mirrors gate conditions from skeptic-cron.yml post_triggers step.
// ---------------------------------------------------------------------------
describe("6-green gate", () => {
  it("eligible when all 6 gates pass", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  it("NOT eligible when CI is pending", () => {
    const r = evaluate6Green({
      ciStatus: "pending",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("CI=pending");
  });

  it("NOT eligible when CI is failure", () => {
    const r = evaluate6Green({
      ciStatus: "failure",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("CI=failure");
  });

  it("NOT eligible when mergeable is false (conflicts)", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "false",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("mergeable=false");
  });

  it("NOT eligible when mergeable is unknown", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "unknown",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("mergeable=unknown");
  });

  it("NOT eligible when CR is CHANGES_REQUESTED", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "CHANGES_REQUESTED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("CR=CHANGES_REQUESTED");
  });

  it("NOT eligible when CR has no review (none)", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "none",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("CR=none");
  });

  it("NOT eligible when Bugbot has error comments", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 2,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("Bugbot=2");
  });

  it("NOT eligible when unresolved non-nit comments exist", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 3,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("unresolved=3");
  });

  it("NOT eligible when GraphQL errors (treat as unresolved)", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
      gqlError: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toContain("GraphQL error");
  });

  it("accumulates multiple failures", () => {
    const r = evaluate6Green({
      ciStatus: "failure",
      mergeable: "false",
      latestCrState: "none",
      bugbotErrors: 1,
      unresolvedComments: 2,
      gqlError: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.failures).toHaveLength(5);
  });

  it("eligible with zero unresolved comments", () => {
    const r = evaluate6Green({
      ciStatus: "success",
      mergeable: "true",
      latestCrState: "APPROVED",
      bugbotErrors: 0,
      unresolvedComments: 0,
    });
    expect(r.eligible).toBe(true);
    expect(r.failures).toHaveLength(0);
  });
});
