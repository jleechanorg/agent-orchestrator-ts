/**
 * Prompt Builder — composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT — constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context — project name, repo, default branch, tracker info, reaction rules
 *   3. User rules — inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() always returns the AO base guidance and project context so
 * bare launches still know about AO-specific commands such as PR claiming.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

/** Core instructions always included for every managed session. */
const CORE_AGENT_PROMPT = `You are an AI coding agent managed by the Agent Orchestrator (ao).

## Instruction Hierarchy
- **Task-specific instructions override base/project rules when they conflict.**

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.`;

/**
 * PR/Git/TDD boilerplate — excluded for planning-only and artifact-only workers
 * that should not create branches, push code, or open PRs.
 */
const PR_BOILERPLATE = `

## PR Workflow
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If you're told to take over or continue work on an existing PR, run \`ao session claim-pr <pr-number-or-url>\` from inside this session before making changes.
- If CI fails, the orchestrator will send you the failures — fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments — address each one, push fixes, and reply to the comments.

## Git Workflow & TDD Mandate
- **TDD Requirement**: You MUST follow a Test-Driven Development (TDD) workflow. Write a failing test first (Red), implement the fix (Green), and then refactor.
- **Evidence-Driven Development (EDD)**: Use your tests to generate the mandatory evidence artifacts (logs, video .mp4/.gif/.cast).
- **Proven Authenticity**: Your ## Evidence section must show the TDD cycle: include the initial failing run (to prove existence of the bug/gap) followed by the successful verification run.
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused — one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- **Evidence Bundle**: Every PR MUST include a ## Evidence section with links to authoritative artifacts (Gists, media).
- **Video Requirement**: Terminal/tmux claims MUST use video evidence (.mp4/.gif/.webm/.mov/.cast). UI/browser claims MUST use video evidence (.mp4/.gif/.webm/.mov); '.cast' is **terminal-only** and is not valid for UI media.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.`;

/**
 * @deprecated Use buildPrompt() with skipPrBoilerplate option instead.
 * Exported only for backward compatibility with tests and external consumers.
 * Note: BASE_AGENT_PROMPT = CORE_AGENT_PROMPT only; PR boilerplate is
 * conditionally added by buildPrompt(). The full combined prompt is
 * buildPrompt({ skipPrBoilerplate: false }).
 */
export const BASE_AGENT_PROMPT = CORE_AGENT_PROMPT;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") — triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Whether branch naming is tracker-driven (passed from caller where branch decision is known) */
  trackerDrivenBranching?: boolean;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;

  /** Decomposition context — ancestor task chain (from decomposer) */
  lineage?: string[];

  /** Decomposition context — sibling task descriptions (from decomposer) */
  siblings?: string[];

  /**
   * When true, the PR/Git/TDD boilerplate is excluded from the base prompt.
   * Use for planning-only, artifact-only, or other non-coding workers that
   * should not attempt to create branches, push code, or open PRs.
   */
  skipPrBoilerplate?: boolean;
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext, trackerDrivenBranching } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    if (trackerDrivenBranching) {
      lines.push(`Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`);
    } else {
      lines.push(`Branch name is auto-generated by the orchestrator — do not set a specific branch name.`);
    }
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable — skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Always returns the AO base guidance plus project context, then layers on
 * issue context, user rules, and explicit instructions when available.
 */
export function buildPrompt(config: PromptBuildConfig): string {
  const userRules = readUserRules(config.project);
  const sections: string[] = [];

  // Layer 1: Core prompt is always included; PR boilerplate is excluded for
  // planning-only and artifact-only workers that should not push code or open PRs.
  sections.push(CORE_AGENT_PROMPT);
  if (!config.skipPrBoilerplate) {
    sections.push(PR_BOILERPLATE);
  }

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Layer 4: Decomposition context (lineage + siblings)
  if (config.lineage && config.lineage.length > 0) {
    const hierarchy = config.lineage.map((desc, i) => `${"  ".repeat(i)}${i}. ${desc}`);
    // Add current task marker using issueId or last lineage entry
    const currentLabel = config.issueId ?? "this task";
    hierarchy.push(`${"  ".repeat(config.lineage.length)}${config.lineage.length}. ${currentLabel}  <-- (this task)`);

    sections.push(
      `## Task Hierarchy\nThis task is part of a larger decomposed plan. Your place in the hierarchy:\n\n\`\`\`\n${hierarchy.join("\n")}\n\`\`\`\n\nStay focused on YOUR specific task. Do not implement functionality that belongs to other tasks in the hierarchy.`,
    );
  }

  if (config.siblings && config.siblings.length > 0) {
    const siblingLines = config.siblings.map((s) => `  - ${s}`);
    sections.push(
      `## Parallel Work\nSibling tasks being worked on in parallel:\n${siblingLines.join("\n")}\n\nDo not duplicate work that sibling tasks handle. If you need interfaces/types from siblings, define reasonable stubs.`,
    );
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  return sections.join("\n\n");
}
