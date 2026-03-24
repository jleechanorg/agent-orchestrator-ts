import { describe, it, expect } from "vitest";
import { buildSkepticPrompt, resolveSkepticModel } from "../skeptic-prompt.js";

describe("resolveSkepticModel", () => {
  it("returns gemini when coder uses claude-code", () => {
    expect(resolveSkepticModel("claude-code")).toBe("gemini");
  });

  it("returns gemini when coder uses claude (any variant)", () => {
    expect(resolveSkepticModel("claude-sonnet")).toBe("gemini");
    expect(resolveSkepticModel("claude")).toBe("gemini");
  });

  it("returns claude-code when coder uses gemini", () => {
    expect(resolveSkepticModel("gemini")).toBe("claude-code");
  });

  it("returns claude-code when coder uses gemini variant", () => {
    expect(resolveSkepticModel("gemini-flash")).toBe("claude-code");
    expect(resolveSkepticModel("antigravity")).toBe("claude-code");
  });

  it("defaults to claude-code for unknown models", () => {
    expect(resolveSkepticModel("codex")).toBe("claude-code");
    expect(resolveSkepticModel("opencode")).toBe("claude-code");
  });
});

describe("buildSkepticPrompt", () => {
  const sampleCriteria = `## Exit Criterion A — Build passes
- pnpm build exits 0
- pnpm test — all tests pass

## Exit Criterion B — Feature works
- The API returns 200 on GET /health`;

  it("includes inverted incentive preamble", () => {
    const prompt = buildSkepticPrompt(sampleCriteria, "claude-code");
    expect(prompt).toContain("Your score is measured by gaps found");
    expect(prompt).toContain("A false PASS is YOUR failure");
  });

  it("includes the criterion replay protocol format", () => {
    const prompt = buildSkepticPrompt(sampleCriteria, "claude-code");
    expect(prompt).toContain("CRITERION:");
    expect(prompt).toContain("COMMAND RUN:");
    expect(prompt).toContain("RAW OUTPUT:");
    expect(prompt).toContain("VERDICT:");
    expect(prompt).toContain("REASON:");
  });

  it("embeds exit criteria content verbatim", () => {
    const prompt = buildSkepticPrompt(sampleCriteria, "claude-code");
    expect(prompt).toContain(sampleCriteria);
  });

  it("includes report output instructions for skeptic-report.json", () => {
    const prompt = buildSkepticPrompt(sampleCriteria, "claude-code");
    expect(prompt).toContain("skeptic-report.json");
  });

  it("includes FORBIDDEN constraints", () => {
    const prompt = buildSkepticPrompt(sampleCriteria, "claude-code");
    expect(prompt).toContain("FORBIDDEN");
  });

  it("includes NOT_ATTEMPTED as a valid verdict option", () => {
    const prompt = buildSkepticPrompt(sampleCriteria, "claude-code");
    expect(prompt).toContain("NOT_ATTEMPTED");
  });

  it("returns a non-empty string", () => {
    const prompt = buildSkepticPrompt("", "claude-code");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
