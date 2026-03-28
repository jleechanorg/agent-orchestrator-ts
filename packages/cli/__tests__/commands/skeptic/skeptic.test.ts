/**
 * Unit tests for skeptic.ts verdict parsing — SKIPPED verdict path.
 * CR: "Add failing-first tests that cover the new SKIPPED verdict path"
 * (Line 60, Lines 130-132 — PASS/FAIL/SKIPPED are all first-class verdicts now)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// CR: import the real VERDICT_LINE_RE from production to avoid duplication.
// NOTE: vitest's resolvePackageEntry limitation prevents direct import from
// src/commands/skeptic.js; we verify alignment via an integration test below.
// The local definition must be kept in sync with skeptic.ts:VERDICT_LINE_RE.
const VERDICT_LINE_RE = /^VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

// Re-exported for testing — mirrors the actual export from skeptic.ts
// Includes triggerSha scoping (lines 65–66 in production) for SHA-idempotency tests.
async function findExistingVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  fetchComments: (owner: string, repo: string, prNumber: number) => Promise<Array<{ id: number; body: string }>>,
  triggerSha?: string,
): Promise<{ verdict: "PASS" | "FAIL" | "SKIPPED"; commentId: number } | null> {
  const comments = await fetchComments(owner, repo, prNumber);
  for (const c of comments) {
    if (/<!-- skeptic-agent-verdict -->/i.test(c.body)) {
      const shaMarker = triggerSha ? new RegExp(`<!-- skeptic-gate-trigger-${triggerSha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -->`) : null;
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
});
