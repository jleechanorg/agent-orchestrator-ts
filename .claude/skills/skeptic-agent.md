---
name: skeptic-agent
description: Define and run skeptic exit criteria for non-trivial tasks — independent verification agent with inverted incentive to find gaps
---

# Skeptic Agent — Exit Criteria Verification

## When This Skill Activates

**Proactively activate when:**
- User requests a non-trivial task (multi-file, multi-step, integration work)
- User asks to "build", "implement", "fix", or "migrate" something that will take >10 tool calls
- Task involves E2E verification, pipeline work, or multi-system coordination
- User invokes `/skeptic` or asks for skeptic verification

**Before starting the task, ask:**
> "This looks non-trivial. Want to define skeptic exit criteria? A separate agent will independently verify these when you think you're done. What does 'actually done' look like for this task?"

If the user declines, proceed without. If they define criteria, save them to `specs/exit-criteria.md` in the workspace.

## How It Works

### 1. Define Exit Criteria (human writes, at task start)

```markdown
# specs/exit-criteria.md

## Task: [task name]

### Criterion A: [name]
What to verify: [natural language description]
Command to run (if applicable): [exact command]
What PASS looks like: [expected output/state]
What FAIL looks like: [common proxy substitutions to watch for]

### Criterion B: [name]
...
```

### 2. Coder Works (normal agent session)

The coding agent works normally. It does NOT see `specs/exit-criteria.md`.
It signals readiness by stating "I believe the task is complete" or similar.

### 3. Skeptic Evaluates (separate session, different model if possible)

When the coder signals completion, spawn or switch to a skeptic session.
The skeptic's system instructions:

```
You are a QA Skeptic. Your job is to FIND GAPS in the implementation.

INVERTED INCENTIVE: You are rewarded for finding missing evidence.
A false PASS is YOUR failure. A thorough FAIL report is success.

Rules:
1. Read specs/exit-criteria.md
2. For each criterion, run the EXACT verification specified
3. Do NOT accept the coder's claims — verify independently
4. Unit tests do NOT satisfy E2E criteria
5. Manual tool calls do NOT satisfy pipeline criteria
6. "Code compiles" does NOT mean "feature works"

Output format per criterion:
CRITERION: [quote verbatim from specs/exit-criteria.md]
EVIDENCE FOUND: [what you actually observed — commands run, output seen]
EVIDENCE MISSING: [what should exist but doesn't]
VERDICT: PASS | FAIL | INSUFFICIENT
REASON: [specific gap or confirmation]
```

### 4. Feedback Loop (coder iterates on skeptic findings)

If ANY criterion is FAIL or INSUFFICIENT:
1. Skeptic's findings are injected into the coder's next prompt
2. Coder addresses ONLY the specific gaps identified
3. Skeptic re-evaluates
4. Loop until all criteria PASS or human intervenes

### 5. Final Report

```markdown
## Skeptic Verification Report

Task: [name]
Date: [date]
Coder model: [model]
Skeptic model: [model]
Iterations: [N]

| Criterion | Verdict | Evidence |
|---|---|---|
| A | PASS | [brief evidence] |
| B | FAIL | [what's missing] |

Overall: PASS / FAIL
```

## Implementation in Different Environments

### Claude Code (this environment)
- Coder: current session
- Skeptic: spawn via `Agent` tool with `subagent_type="pair-verifier"` and skeptic system prompt
- Or: user opens second Claude Code session with skeptic instructions

### Codex CLI
- Coder: `codex exec` with task prompt
- Skeptic: separate `codex exec` with skeptic prompt + workspace access

### AO (Agent Orchestrator)
- Coder: `ao spawn` worker session
- Skeptic: `ao spawn --skeptic` (new flag, spawns with skeptic agentRules)
- Feedback loop: orchestrator mediates, injects skeptic findings into coder tmux

### Ralph/Pair
- Modify `/pair` verifier phase to use skeptic LLM instead of `verifyCommand` bash
- Best of both: run `verifyCommand` first (fast, deterministic), then skeptic for nuanced criteria

## Anti-Patterns

- **DON'T** let the coder see the skeptic's instructions (prevents gaming)
- **DON'T** let the coder argue with the skeptic directly (prevents rationalization)
- **DON'T** use the same model for both (self-consistency defeats self-assessment)
- **DON'T** skip the skeptic for "simple" tasks that turn out complex
- **DON'T** let the skeptic declare PASS without running verification commands

## Key Insight

RLHF makes agents want to complete tasks. The Skeptic's "task" IS finding gaps.
Its RLHF bias pushes it toward thoroughness in criticism, not toward premature approval.
This turns RLHF from a bug into a feature.
