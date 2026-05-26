import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildPrompt, BASE_AGENT_PROMPT, CORE_AGENT_PROMPT, PR_BOILERPLATE, type OverlappingSession } from "../prompt-builder.js";
import { buildWorkerPromptArtifact, type WorkerPromptArtifactConfig } from "../prompt-artifact-builder.js";
import { readFileSync } from "node:fs";
import type { Agent, Issue, ProjectConfig, SessionSpawnConfig } from "../types.js";

let tmpDir: string;
let project: ProjectConfig;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-prompt-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  project = {
    name: "Test App",
    repo: "org/test-app",
    path: tmpDir,
    defaultBranch: "main",
    sessionPrefix: "test",
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildPrompt", () => {
  it("includes base prompt on bare spawns", () => {
    const result = buildPrompt({ project, projectId: "test-app" });
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("## Project Context");
    expect(result).toContain("Project: Test App");
  });

  it("includes base prompt when issue is provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
  });

  it("includes project context", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Test App");
    expect(result).toContain("org/test-app");
    expect(result).toContain("main");
  });

  it("includes issue ID in task section", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Work on issue: INT-1343");
    // When trackerDrivenBranching is not set, branch name is auto-generated
    expect(result).toContain("Branch name is auto-generated");
    expect(result).not.toContain("feat/INT-1343");
  });

  it("uses tracker branch guidance when trackerDrivenBranching is true", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System",
      trackerDrivenBranching: true,
    });
    expect(result).toContain("Work on issue: INT-1343");
    // With trackerDrivenBranching=true, branch name links to tracker
    expect(result).toContain("feat/INT-1343");
    expect(result).not.toContain("Branch name is auto-generated");
  });

  it("uses auto-generated branch guidance when trackerDrivenBranching is false even with issueContext", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System",
      trackerDrivenBranching: false,
    });
    expect(result).toContain("Work on issue: INT-1343");
    // When trackerDrivenBranching=false, branch is auto-generated (issue context irrelevant)
    expect(result).toContain("Branch name is auto-generated");
    expect(result).not.toContain("feat/INT-1343");
  });

  it("uses tracker branch guidance even when issueContext is undefined (generatePrompt failure scenario)", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      // issueContext deliberately undefined (simulates generatePrompt() failure)
      trackerDrivenBranching: true,
    });
    expect(result).toContain("Work on issue: INT-1343");
    // Even with missing issueContext, explicit flag ensures tracker-driven branch guidance
    expect(result).toContain("feat/INT-1343");
    expect(result).not.toContain("Branch name is auto-generated");
  });

  it("includes issue context when provided", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Layered Prompt System\nPriority: High",
    });
    expect(result).toContain("## Issue Details");
    expect(result).toContain("Layered Prompt System");
    expect(result).toContain("Priority: High");
  });

  it("includes inline agentRules", () => {
    project.agentRules = "Always run pnpm test before pushing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("## Project Rules");
    expect(result).toContain("Always run pnpm test before pushing.");
  });

  it("reads agentRulesFile content", () => {
    const rulesPath = join(tmpDir, "agent-rules.md");
    writeFileSync(rulesPath, "Use conventional commits.\nNo force pushes.");
    project.agentRulesFile = "agent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Use conventional commits.");
    expect(result).toContain("No force pushes.");
  });

  it("includes both agentRules and agentRulesFile", () => {
    project.agentRules = "Inline rule.";
    const rulesPath = join(tmpDir, "rules.txt");
    writeFileSync(rulesPath, "File rule.");
    project.agentRulesFile = "rules.txt";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).toContain("Inline rule.");
    expect(result).toContain("File rule.");
  });

  it("handles missing agentRulesFile gracefully", () => {
    project.agentRulesFile = "nonexistent-rules.md";

    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    // Should not throw, should still build prompt without rules
    expect(result).not.toBeNull();
    expect(result).not.toContain("## Project Rules");
  });

  it("appends userPrompt last", () => {
    project.agentRules = "Project rule.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      userPrompt: "Focus on the API layer only.",
    });

    expect(result).not.toBeNull();
    const promptStr = result!;

    // User prompt should come after project rules
    const rulesIdx = promptStr.indexOf("Project rule.");
    const userIdx = promptStr.indexOf("Focus on the API layer only.");
    expect(rulesIdx).toBeLessThan(userIdx);
    expect(promptStr).toContain("## Additional Instructions");
  });

  it("builds prompt from rules alone (no issue)", () => {
    project.agentRules = "Always lint before committing.";
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).not.toBeNull();
    expect(result).toContain(BASE_AGENT_PROMPT);
    expect(result).toContain("Always lint before committing.");
  });

  it("builds prompt from userPrompt alone (no issue, no rules)", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      userPrompt: "Just explore the codebase.",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Just explore the codebase.");
  });

  it("includes tracker info in context", () => {
    project.tracker = { plugin: "linear" };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("Tracker: linear");
  });

  it("uses project name in context", () => {
    const result = buildPrompt({
      project,
      projectId: "my-project",
      issueId: "INT-100",
    });
    expect(result).toContain("Project: Test App");
  });

  it("includes reaction hints for auto send-to-agent reactions", () => {
    project.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent" },
      "approved-and-green": { auto: false, action: "notify" },
    };
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-100",
    });
    expect(result).toContain("ci-failed");
    expect(result).not.toContain("approved-and-green");
  });

  it("excludes PR boilerplate when skipPrBoilerplate=true", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      skipPrBoilerplate: true,
    });
    // Should still include core prompt
    expect(result).toContain(CORE_AGENT_PROMPT);
    // Should NOT include PR-specific instructions
    expect(result).not.toContain("When you finish your work, create a PR and push it");
    expect(result).not.toContain("fix them and push again");
    expect(result).not.toContain("push fixes");
    expect(result).not.toContain("## Git Workflow & TDD Mandate");
    expect(result).not.toContain("## PR Best Practices");
  });

  it("includes PR boilerplate when skipPrBoilerplate=false", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      skipPrBoilerplate: false,
    });
    // Should include both core and PR boilerplate
    expect(result).toContain(CORE_AGENT_PROMPT);
    expect(result).toContain("When you finish your work, create a PR and push it");
    expect(result).toContain("fix them and push again");
    expect(result).toContain("## Git Workflow & TDD Mandate");
    expect(result).toContain("## PR Best Practices");
  });

  it("includes PR boilerplate by default (skipPrBoilerplate not set)", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
    });
    expect(result).toContain("When you finish your work, create a PR and push it");
    expect(result).toContain("## Git Workflow & TDD Mandate");
    expect(result).toContain("## PR Best Practices");
  });
});

describe("BASE_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof BASE_AGENT_PROMPT).toBe("string");
    expect(BASE_AGENT_PROMPT.length).toBeGreaterThan(100);
  });

  it("covers core AO session topics (excludes PR-specific content)", () => {
    expect(BASE_AGENT_PROMPT).toContain("Session Lifecycle");
    expect(BASE_AGENT_PROMPT).toContain("Instruction Hierarchy");
    // PR-specific content moved to PR_BOILERPLATE
    expect(BASE_AGENT_PROMPT).not.toContain("Git Workflow");
    expect(BASE_AGENT_PROMPT).not.toContain("ao session claim-pr");
  });
});

describe("skipPrBoilerplate", () => {
  it("omits PR/Git/TDD sections when true", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      skipPrBoilerplate: true,
    });
    expect(result).toContain("Session Lifecycle");
    expect(result).not.toContain("Git Workflow");
    expect(result).not.toContain("PR Best Practices");
    expect(result).not.toContain("TDD Requirement");
    expect(result).not.toContain("Evidence Bundle");
  });

  it("includes PR/Git/TDD sections when false", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      skipPrBoilerplate: false,
    });
    expect(result).toContain("Session Lifecycle");
    expect(result).toContain("Git Workflow");
    expect(result).toContain("PR Best Practices");
    expect(result).toContain("TDD Requirement");
  });

  it("defaults to including PR boilerplate when omitted", () => {
    const result = buildPrompt({ project, projectId: "test-app" });
    expect(result).toContain("Git Workflow");
    expect(result).toContain("PR Best Practices");
  });
});

describe("CORE_AGENT_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof CORE_AGENT_PROMPT).toBe("string");
    expect(CORE_AGENT_PROMPT.length).toBeGreaterThan(50);
  });

  it("does NOT contain PR/push instructions", () => {
    expect(CORE_AGENT_PROMPT).not.toContain("create a PR and push it");
    expect(CORE_AGENT_PROMPT).not.toContain("fix them and push again");
    expect(CORE_AGENT_PROMPT).not.toContain("push fixes");
    expect(CORE_AGENT_PROMPT).not.toContain("## Git Workflow");
    expect(CORE_AGENT_PROMPT).not.toContain("## PR Best Practices");
  });

  it("contains session lifecycle guidance", () => {
    expect(CORE_AGENT_PROMPT).toContain("Session Lifecycle");
    expect(CORE_AGENT_PROMPT).toContain("managed session");
  });
});

describe("PR_BOILERPLATE", () => {
  it("is a non-empty string", () => {
    expect(typeof PR_BOILERPLATE).toBe("string");
    expect(PR_BOILERPLATE.length).toBeGreaterThan(50);
  });

  it("contains PR/push instructions", () => {
    expect(PR_BOILERPLATE).toContain("create a PR and push it");
    expect(PR_BOILERPLATE).toContain("fix them and push again");
  });

  it("contains TDD and evidence guidance", () => {
    expect(PR_BOILERPLATE).toContain("## Git Workflow & TDD Mandate");
    expect(PR_BOILERPLATE).toContain("## PR Best Practices");
  });
});

describe("Scope Guard", () => {
  it("is injected when issueContext is present", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "## Linear Issue INT-1343\nTitle: Fix rate limiter",
    });
    expect(result).toContain("## Scope Guard");
    expect(result).toContain("scope creep");
    expect(result).toContain("Focus exclusively on the files and domains mentioned in the bead description above");
  });

  it("is NOT injected when issueContext is absent (ad-hoc task)", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).not.toContain("## Scope Guard");
    expect(result).not.toContain("scope creep");
  });

  it("is NOT injected when issueContext is empty string", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      issueContext: "",
    });
    expect(result).not.toContain("## Scope Guard");
  });
});

describe("Overlapping Work (Dedup Guard)", () => {
  it("is injected when overlappingSessions is non-empty", () => {
    const overlapping: OverlappingSession[] = [
      { sessionId: "sess-abc", beadId: "bd-100", scope: "Fix rate limit handler" },
      { sessionId: "sess-def", beadId: "bd-101", scope: "Refactor SCM module" },
    ];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      overlappingSessions: overlapping,
    });
    expect(result).toContain("## Overlapping Work");
    expect(result).toContain("[sess-abc]");
    expect(result).toContain("(bd-100)");
    expect(result).toContain("Fix rate limit handler");
    expect(result).toContain("[sess-def]");
    expect(result).toContain("(bd-101)");
    expect(result).toContain("Refactor SCM module");
    expect(result).toContain("Do not duplicate their work");
  });

  it("is NOT injected when overlappingSessions is empty array", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      overlappingSessions: [],
    });
    expect(result).not.toContain("## Overlapping Work");
  });

  it("is NOT injected when overlappingSessions is undefined", () => {
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
    });
    expect(result).not.toContain("## Overlapping Work");
  });

  it("formats each overlapping session with session ID, bead ID, and scope", () => {
    const overlapping: OverlappingSession[] = [
      { sessionId: "sess-xyz", beadId: "bd-200", scope: "Add scope guard" },
    ];
    const result = buildPrompt({
      project,
      projectId: "test-app",
      issueId: "INT-1343",
      overlappingSessions: overlapping,
    });
    expect(result).toContain("- [sess-xyz] (bd-200): Add scope guard");
  });
});

describe("buildWorkerPromptArtifact", () => {
  const stubAgent = {
    name: "test-agent",
    processName: "test",
    supportsSystemPromptFile: false,
    getLaunchCommand: () => "echo hello",
    getEnvironment: () => ({}),
    detectActivity: () => "idle" as const,
    getActivityState: async () => null,
    isProcessRunning: async () => ({ running: false }),
    getSessionInfo: async () => null,
  } as unknown as Agent;

  function makeConfig(overrides: Partial<WorkerPromptArtifactConfig> = {}): WorkerPromptArtifactConfig {
    return {
      agent: stubAgent,
      configPath: tmpDir,
      hasTracker: false,
      issueContext: undefined,
      project,
      resolvedIssue: undefined,
      sessionId: "test-session",
      spawnConfig: {
        projectId: "test-app",
      },
      composedPromptPath: join(tmpDir, "composed-prompt.md"),
      ...overrides,
    };
  }

  it("writes composed prompt file to disk", () => {
    const config = makeConfig();
    const result = buildWorkerPromptArtifact(config);

    expect(result.composedPromptPath).toBe(join(tmpDir, "composed-prompt.md"));
    const content = readFileSync(result.composedPromptPath, "utf-8");
    expect(content).toContain(BASE_AGENT_PROMPT);
  });

  it("passes overlappingSessions through to buildPrompt", () => {
    const overlapping: OverlappingSession[] = [
      { sessionId: "sess-abc", beadId: "bd-100", scope: "Fix auth module" },
    ];
    const config = makeConfig({ overlappingSessions: overlapping });
    const result = buildWorkerPromptArtifact(config);

    const content = readFileSync(result.composedPromptPath, "utf-8");
    expect(content).toContain("## Overlapping Work");
    expect(content).toContain("[sess-abc]");
    expect(content).toContain("(bd-100)");
    expect(content).toContain("Fix auth module");
  });

  it("omits Overlapping Work section when overlappingSessions is undefined", () => {
    const config = makeConfig();
    const result = buildWorkerPromptArtifact(config);

    const content = readFileSync(result.composedPromptPath, "utf-8");
    expect(content).not.toContain("## Overlapping Work");
  });

  it("uses WORKER_BOOT_PROMPT for agents with supportsSystemPromptFile", () => {
    const promptFileAgent = {
      ...stubAgent,
      supportsSystemPromptFile: true,
    } as unknown as Agent;
    const config = makeConfig({ agent: promptFileAgent });
    const result = buildWorkerPromptArtifact(config);

    expect(result.launchPrompt).toBe("Begin the assigned AO worker task. Follow the session instructions file.");
  });

  it("uses composed prompt as launchPrompt for agents without supportsSystemPromptFile", () => {
    const config = makeConfig();
    const result = buildWorkerPromptArtifact(config);

    expect(result.launchPrompt).toBe(result.postLaunchPrompt);
  });

  it("sets skipPrBoilerplate from config override", () => {
    const config = makeConfig({ skipPrBoilerplate: true });
    const result = buildWorkerPromptArtifact(config);

    const content = readFileSync(result.composedPromptPath, "utf-8");
    expect(content).toContain("Session Lifecycle");
    expect(content).not.toContain("Git Workflow");
  });

  it("falls back to spawnConfig.skipPrBoilerplate when config skipPrBoilerplate is undefined", () => {
    const config = makeConfig({
      spawnConfig: { projectId: "test-app", skipPrBoilerplate: true },
    });
    const result = buildWorkerPromptArtifact(config);

    const content = readFileSync(result.composedPromptPath, "utf-8");
    expect(content).not.toContain("Git Workflow");
  });

  it("resolves ad-hoc task when issueId present but no resolved issue with tracker", () => {
    const config = makeConfig({
      hasTracker: true,
      resolvedIssue: undefined,
      spawnConfig: { projectId: "test-app", issueId: "INT-500" },
    });
    const result = buildWorkerPromptArtifact(config);

    expect(result.promptIssueId).toBeUndefined();
    expect(result.requestedTask).toBe("INT-500");
  });

  it("preserves issueId when resolved issue exists with tracker", () => {
    const resolved: Issue = {
      id: "INT-500",
      title: "Fix scope guard",
      description: "Details",
      url: "https://example.com",
      state: "open",
      labels: [],
    };
    const config = makeConfig({
      hasTracker: true,
      resolvedIssue: resolved,
      spawnConfig: { projectId: "test-app", issueId: "INT-500" },
    });
    const result = buildWorkerPromptArtifact(config);

    expect(result.promptIssueId).toBe("INT-500");
  });
});
