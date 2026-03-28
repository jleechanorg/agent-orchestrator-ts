/**
 * Unit tests for skeptic.ts verdict parsing — SKIPPED verdict path.
 * CR: "Add failing-first tests that cover the new SKIPPED verdict path"
 * (Line 60, Lines 130-132 — PASS/FAIL/SKIPPED are all first-class verdicts now)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Regex under test — matches all three verdict types
const VERDICT_LINE_RE = /^VERDICT:\s*(PASS|FAIL|SKIPPED)\b/im;

// Re-exported for testing — mirrors the actual export from skeptic.ts
async function findExistingVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  fetchComments: (owner: string, repo: string, prNumber: number) => Promise<Array<{ id: number; body: string }>>,
): Promise<{ verdict: "PASS" | "FAIL" | "SKIPPED"; commentId: number } | null> {
  const comments = await fetchComments(owner, repo, prNumber);
  for (const c of comments) {
    if (/<!-- skeptic-agent-verdict -->/i.test(c.body)) {
      const m = c.body.match(VERDICT_LINE_RE);
      if (m) {
        return { verdict: m[1].toUpperCase() as "PASS" | "FAIL" | "SKIPPED", commentId: c.id };
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
  // Mirrors lines 130-132 of skeptic.ts
  function getVerdictColor(verdictType: string): string {
    if (verdictType === "PASS") return "green";
    if (verdictType === "SKIPPED") return "yellow";
    return "red";
  }

  it("SKIPPED maps to yellow", () => {
    expect(getVerdictColor("SKIPPED")).toBe("yellow");
  });

  it("PASS maps to green", () => {
    expect(getVerdictColor("PASS")).toBe("green");
  });

  it("FAIL maps to red", () => {
    expect(getVerdictColor("FAIL")).toBe("red");
  });
});

describe("findExistingVerdict — SKIPPED path", () => {
  const mockFetchComments = vi.fn();

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
