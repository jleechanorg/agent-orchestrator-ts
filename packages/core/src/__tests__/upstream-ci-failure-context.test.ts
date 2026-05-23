import { describe, it, expect, vi } from "vitest";
import {
  isFailedCICheck,
  escapeMarkdownCodeFenceClosers,
  formatCIFailureMessage,
  getFailedCIChecks,
  makeCIFailureFingerprint,
  enrichCIFailureReaction,
} from "../upstream-ci-failure-context.js";
import type { SCM, CICheck, PRInfo, ReactionConfig } from "../types.js";

const mockPR: PRInfo = { owner: "org", repo: "repo", number: 42, headBranch: "feat", baseBranch: "main" };

function makeCheck(overrides: Partial<CICheck> = {}): CICheck {
  return {
    name: "build",
    status: "failed",
    ...overrides,
  };
}

describe("isFailedCICheck", () => {
  it("returns true for status=failed", () => {
    expect(isFailedCICheck(makeCheck({ status: "failed" }))).toBe(true);
  });

  it("returns true for conclusion=FAILURE", () => {
    expect(isFailedCICheck(makeCheck({ status: "completed", conclusion: "FAILURE" }))).toBe(true);
  });

  it("returns true for conclusion=failure (case-insensitive)", () => {
    expect(isFailedCICheck(makeCheck({ status: "completed", conclusion: "failure" }))).toBe(true);
  });

  it("returns false for passing check", () => {
    expect(isFailedCICheck(makeCheck({ status: "passed", conclusion: "SUCCESS" }))).toBe(false);
  });

  it("returns false for running check", () => {
    expect(isFailedCICheck(makeCheck({ status: "running" }))).toBe(false);
  });

  it("returns false for skipped check", () => {
    expect(isFailedCICheck(makeCheck({ status: "skipped" }))).toBe(false);
  });
});

describe("escapeMarkdownCodeFenceClosers", () => {
  it("escapes lines starting with triple backticks", () => {
    const input = "some text\n```\nmore text\n```";
    const result = escapeMarkdownCodeFenceClosers(input);
    expect(result).toContain("\u200B```");
    expect(result).not.toMatch(/^```/m);
  });

  it("leaves non-fence lines unchanged", () => {
    const input = "hello\nworld";
    expect(escapeMarkdownCodeFenceClosers(input)).toBe("hello\nworld");
  });

  it("handles CRLF line endings", () => {
    const input = "line1\r\n```\r\nline3";
    const result = escapeMarkdownCodeFenceClosers(input);
    expect(result).toContain("\u200B```");
  });
});

describe("formatCIFailureMessage", () => {
  it("uses summary message when getCIFailureSummary returns jobs", async () => {
    const summary = {
      failedJobs: [
        { name: "build", failedStep: "compile", runUrl: "https://github.com/runs/1", logTail: "error TS2304" },
      ],
    };
    const mockSCM = {
      getCIFailureSummary: vi.fn().mockResolvedValue(summary),
    } as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("CI is failing on your PR");
    expect(result).toContain("build → compile");
    expect(result).toContain("https://github.com/runs/1");
    expect(result).toContain("error TS2304");
    expect(result).toContain("Fix the issues and push again");
  });

  it("falls back to check list when getCIFailureSummary returns null", async () => {
    const mockSCM = {
      getCIFailureSummary: vi.fn().mockResolvedValue(null),
    } as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("CI checks are failing on your PR");
    expect(result).toContain("build");
  });

  it("falls back when getCIFailureSummary throws", async () => {
    const mockSCM = {
      getCIFailureSummary: vi.fn().mockRejectedValue(new Error("API error")),
    } as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("CI checks are failing on your PR");
  });

  it("falls back when SCM has no getCIFailureSummary", async () => {
    const mockSCM = {} as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("CI checks are failing on your PR");
    expect(result).toContain("build");
  });

  it("includes URL in fallback when check has url", async () => {
    const mockSCM = {} as unknown as SCM;
    const check = makeCheck({ url: "https://github.com/runs/1" });

    const result = await formatCIFailureMessage(mockSCM, mockPR, [check]);
    expect(result).toContain("https://github.com/runs/1");
  });

  it("formats summary with log tail and line count", async () => {
    const logTail = "line1\nline2\nline3";
    const summary = {
      failedJobs: [
        { name: "test", runUrl: "https://github.com/runs/2", logTail },
      ],
    };
    const mockSCM = {
      getCIFailureSummary: vi.fn().mockResolvedValue(summary),
    } as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("Log tail (last 3 lines)");
  });

  it("formats summary with single-line log tail", async () => {
    const logTail = "only one line";
    const summary = {
      failedJobs: [
        { name: "lint", runUrl: "https://github.com/runs/3", logTail },
      ],
    };
    const mockSCM = {
      getCIFailureSummary: vi.fn().mockResolvedValue(summary),
    } as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("Log tail (last 1 line)");
  });

  it("formats summary without failedStep", async () => {
    const summary = {
      failedJobs: [
        { name: "deploy", runUrl: "https://github.com/runs/4" },
      ],
    };
    const mockSCM = {
      getCIFailureSummary: vi.fn().mockResolvedValue(summary),
    } as unknown as SCM;

    const result = await formatCIFailureMessage(mockSCM, mockPR, [makeCheck()]);
    expect(result).toContain("Failed: deploy");
    expect(result).not.toContain("→");
  });
});

describe("getFailedCIChecks", () => {
  it("returns failed checks when allowFetch and SCM returns checks", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockResolvedValue([
        makeCheck({ name: "build", status: "failed" }),
        makeCheck({ name: "lint", status: "passed" }),
      ]),
    } as unknown as SCM;

    const result = await getFailedCIChecks(mockSCM, mockPR, { allowFetch: true });
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("build");
  });

  it("returns null when no failed checks", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockResolvedValue([
        makeCheck({ name: "build", status: "passed" }),
      ]),
    } as unknown as SCM;

    const result = await getFailedCIChecks(mockSCM, mockPR, { allowFetch: true });
    expect(result).toBeNull();
  });

  it("returns null when getCIChecks throws", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockRejectedValue(new Error("rate limit")),
    } as unknown as SCM;

    const result = await getFailedCIChecks(mockSCM, mockPR, { allowFetch: true });
    expect(result).toBeNull();
  });

  it("returns null when allowFetch is false and no checks provided", async () => {
    const mockSCM = {} as unknown as SCM;
    const result = await getFailedCIChecks(mockSCM, mockPR, { allowFetch: false });
    expect(result).toBeNull();
  });
});

describe("makeCIFailureFingerprint", () => {
  it("creates fingerprint from check name, status, and conclusion", () => {
    const checks = [
      makeCheck({ name: "build", status: "failed", conclusion: "FAILURE" }),
      makeCheck({ name: "test", status: "failed" }),
    ];
    const fp = makeCIFailureFingerprint(checks);
    expect(fp).toBe("build:failed:FAILURE|test:failed:");
  });

  it("produces stable fingerprint regardless of input order", () => {
    const checksA = [
      makeCheck({ name: "build", status: "failed" }),
      makeCheck({ name: "test", status: "failed" }),
    ];
    const checksB = [
      makeCheck({ name: "test", status: "failed" }),
      makeCheck({ name: "build", status: "failed" }),
    ];
    expect(makeCIFailureFingerprint(checksA)).toBe(makeCIFailureFingerprint(checksB));
  });

  it("returns empty string for empty array", () => {
    expect(makeCIFailureFingerprint([])).toBe("");
  });
});

describe("enrichCIFailureReaction", () => {
  const baseConfig: ReactionConfig = {
    auto: true,
    action: "send-to-agent",
    message: "CI failed",
    retries: 2,
    escalateAfter: 2,
  };

  it("preserves existing message when no failed checks found", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockRejectedValue(new Error("unavailable")),
    } as unknown as SCM;

    const result = await enrichCIFailureReaction(mockSCM, mockPR, baseConfig, true);
    expect(result.enriched).toBe(false);
    expect(result.config.message).toBe("CI failed");
    expect(result.config.action).toBe("send-to-agent");
  });

  it("uses default message when no failed checks and no existing message", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockRejectedValue(new Error("unavailable")),
    } as unknown as SCM;
    const configNoMessage: ReactionConfig = { auto: true, action: "send-to-agent" };

    const result = await enrichCIFailureReaction(mockSCM, mockPR, configNoMessage, true);
    expect(result.enriched).toBe(false);
    expect(result.config.message).toContain("Run `gh pr checks`");
  });

  it("enriches message with failed check details", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockResolvedValue([
        makeCheck({ name: "build", status: "failed", conclusion: "FAILURE" }),
      ]),
    } as unknown as SCM;

    const result = await enrichCIFailureReaction(mockSCM, mockPR, baseConfig, true);
    expect(result.enriched).toBe(true);
    expect(result.config.message).toContain("CI failed");
    expect(result.config.message).toContain("build");
    expect(result.config.action).toBe("send-to-agent");
  });

  it("preserves non-message config properties", async () => {
    const mockSCM = {
      getCIChecks: vi.fn().mockRejectedValue(new Error("unavailable")),
    } as unknown as SCM;

    const result = await enrichCIFailureReaction(mockSCM, mockPR, baseConfig, true);
    expect(result.config.retries).toBe(2);
    expect(result.config.escalateAfter).toBe(2);
    expect(result.config.auto).toBe(true);
    expect(result.config.message).toBe("CI failed");
  });

  it("merges CI context into {{context}} template when present", async () => {
    const templateConfig: ReactionConfig = {
      auto: true,
      action: "send-to-agent",
      message: "Agent needs help. {{context}} Please fix ASAP.",
    };
    const mockSCM = {
      getCIChecks: vi.fn().mockResolvedValue([
        makeCheck({ name: "build", status: "failed", conclusion: "FAILURE" }),
      ]),
    } as unknown as SCM;

    const result = await enrichCIFailureReaction(mockSCM, mockPR, templateConfig, true);
    expect(result.enriched).toBe(true);
    expect(result.config.message).toContain("Agent needs help.");
    expect(result.config.message).toContain("build");
    expect(result.config.message).toContain("Please fix ASAP.");
    expect(result.config.message).not.toContain("{{context}}");
  });

  it("uses summary enrichment when available", async () => {
    const summary = {
      failedJobs: [
        { name: "build", failedStep: "compile", runUrl: "https://github.com/runs/1" },
      ],
    };
    const mockSCM = {
      getCIChecks: vi.fn().mockResolvedValue([
        makeCheck({ name: "build", status: "failed", conclusion: "FAILURE" }),
      ]),
      getCIFailureSummary: vi.fn().mockResolvedValue(summary),
    } as unknown as SCM;

    const result = await enrichCIFailureReaction(mockSCM, mockPR, baseConfig, true);
    expect(result.enriched).toBe(true);
    expect(result.config.message).toContain("build → compile");
  });
});
