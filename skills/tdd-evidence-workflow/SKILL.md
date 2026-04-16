---
name: tdd-evidence-workflow
description: TDD-driven evidence workflow for generating authoritative failure/fix proof in PRs.
---

# TDD-Driven Evidence Workflow (Evidence-Driven Development)

This skill operationalizes Test-Driven Development (TDD) as the primary mechanism for generating authentic, authoritative evidence for pull requests.

## Core Principle: No Evidence without Proving the Failure

Authentication of a fix requires proving that the bug or gap existed *immediately before* the fix was applied. This is achieved by capturing the "Red" phase of TDD.

## The Workflow

All AO workers and agents MUST follow these steps for every bug fix or feature implementation:

### 1. Identify and Reproduce (The "Red" Phase)
- **Action**: Write a new test case (unit, integration, or E2E) that fails due to the missing feature or existing bug.
- **Evidence Capture**: Run this test and capture the failure. 
  - For **Terminal** work: Capture the fenced log output showing the failure (e.g., `AssertionError`).
  - For **UI/Interactive** work: Capture a **video (.mp4/.gif/.cast)** showing the failing interaction.
- **Artifact**: Label this as `initial_failure` or `red_phase` in your evidence bundle.

### 2. Implement and Verify (The "Green" Phase)
- **Action**: Implement the minimal code changes required to make the test pass.
- **Evidence Capture**: Run the same test again and capture the success.
  - For **Terminal** work: Capture the fenced log output showing `PASS`.
  - For **UI/Interactive** work: Capture a **video (.mp4/.gif/.cast)** showing the successful interaction.
- **Artifact**: Label this as `final_verification` or `green_phase` in your evidence bundle.

### 3. Refactor and Finalize
- **Action**: Clean up the code, ensure it adheres to style guidelines, and run the full test suite.
- **Evidence Capture**: Final test results for the entire component.

## Mandatory Evidence Structure

Your `## Evidence` section in the PR MUST include both phases:

```markdown
## Evidence

### TDD Cycle Proof
- **Initial Failure (Red)**: [repro_failure.log](URL) or [repro_video.mp4](URL)
- **Final Verification (Green)**: [verify_success.log](URL) or [verify_video.mp4](URL)

### Summary
| Phase | Result | Artifact |
|-------|--------|----------|
| Red   | FAIL   | logs/initial.log |
| Green | PASS   | logs/final.log |
```

## Why Video for UI/Interactive?

Screenshots are point-in-time snapshots that can be easily faked or misinterpreted. Video captures the **temporal progression** of the fix, especially when showing the "failed state" transitioning to the "fixed state" in the same or sequential recordings.

## Linkage to Other Skills

- [Evidence Standards](../evidence-standards/SKILL.md) - Artifact requirements.
- [UI Video Evidence](../ui-video-evidence/SKILL.md) - How to capture UI video.
- [Tmux Video Evidence](../tmux-video-evidence/SKILL.md) - How to capture terminal video.
