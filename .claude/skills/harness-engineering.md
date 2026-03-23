# Harness Engineering Skill

## Purpose

When a mistake or failure pattern is identified, analyze whether the root cause is a gap in the **harness** (instructions, skills, tests, guardrails, automation) rather than just the code. Produce a concrete fix at the harness level so the same class of mistake cannot recur without human intervention.

**Command**: `~/.claude/commands/harness.md`

## Harness Layers (ordered by durability)

| Layer | Files | What it prevents |
|-------|-------|-----------------|
| **Instructions** | `CLAUDE.md`, `AGENTS.md` (global + repo) | Wrong approach, wrong assumptions, wrong defaults |
| **Skills** | `~/.claude/skills/*.md`, `~/.claude/commands/*.md` | Repeated manual workflows, forgotten validation steps |
| **Memory** | `~/.claude/projects/*/memory/*.md` | Forgetting user preferences, past corrections, project context |
| **Integration tests** | `tests/test_integration_*.py`, `tests/test_*_test.py` | Regressions in real behavior |
| **CI gates** | `.github/workflows/*.yml`, pre-commit hooks | Merging broken code, mislabeled artifacts |
| **Lint/validation rules** | `.pre-commit-config.yaml`, custom linters | Style drift, naming violations, structural problems |

## Analysis Protocol

When invoked, execute this sequence **in full, every time**:

### Step 1: Identify the failure class

Classify what went wrong:
- **Mislabeled artifact** — something was called X but didn't meet X's criteria (e.g., "E2E test" that isn't E2E)
- **Wrong approach** — took an approach the user has previously corrected
- **Missing validation** — produced output without checking it meets requirements
- **Repeated manual fix** — user had to manually correct the same type of issue more than once
- **Silent degradation** — something broke but nothing flagged it (includes: harness layer present but broken)
- **Knowledge gap** — didn't know about a constraint, convention, or tool
- **LLM path error** — the agent reasoned toward a wrong solution despite having sufficient context

### Step 2: 5 Whys — the technical problem

Ask "Why?" five times about the technical failure, drilling into root cause:

```
Why 1: Why did the observable failure happen?
Why 2: Why did the mechanism that caused Why 1 exist?
Why 3: Why wasn't that mechanism caught or prevented?
Why 4: Why wasn't there a guardrail at that level?
Why 5: Why was the system designed without that guardrail?
→ Root cause: <single sentence>
```

Stop earlier if you hit bedrock. Each answer should be more specific than the last.

### Step 3: 5 Whys — the agent path

Ask "Why?" five times about why **the LLM (Claude Code or any coding agent)** went down the wrong path. This is mandatory. Every harness failure has two dimensions: the technical problem AND the agent reasoning failure that let it slip through.

```
Why 1: Why did the agent not catch/prevent the failure?
Why 2: Why did the agent reason or act that way?
Why 3: Why didn't the agent's instructions prevent that reasoning?
Why 4: Why wasn't there a skill, memory, or rule that would have redirected the agent?
Why 5: Why was the harness incomplete for this class of agent behavior?
→ Agent root cause: <single sentence>
```

Key questions to drive this:
- Did the agent **trust existing code** without verifying it worked correctly?
- Did the agent describe the problem correctly but at the wrong level of abstraction (high-level summary instead of exact code trace)?
- Did the agent assume "present = working" when it should have verified?
- Did the agent skip verification because the skill/instruction didn't mandate it?
- Was there a confirmation bias: the agent found what looked like the expected pattern and stopped searching?

### Step 4: Find the harness gap

For each failure class, check which harness layers are missing or insufficient:

1. **Read existing instructions** — `~/.claude/CLAUDE.md`, repo `CLAUDE.md`, `~/.codex/AGENTS.md`
   - Is the rule already documented? If yes → it's an adherence problem, add a stronger enforcement instruction
   - If no → add the rule
2. **Check for existing skills** — `~/.claude/skills/`, `~/.claude/commands/`
   - Is there a skill that should have caught this? If yes → update it
   - If no and the pattern is repeatable → create a skill
3. **Check memory** — `~/.claude/projects/*/memory/`
   - Was this corrected before? If yes → the memory wasn't sufficient; strengthen it
   - If no → save feedback memory
4. **Check tests** — are there tests that would catch this regression?
   - If no → propose an integration test
5. **Check CI** — would CI have caught this before merge?
   - If no → propose a CI gate or pre-commit hook

**Critical check — harness layer present but broken:**
For each harness layer that exists, verify it **actually works**, not just that it exists. A broken guardrail is as bad as a missing one and is harder to detect.

### Step 5: Propose the fix

Output a concrete action plan:

```
FAILURE CLASS: <classification>

5 WHYS — TECHNICAL:
1. <why>
2. <why>
3. <why>
4. <why>
5. <why>
→ Root cause: <sentence>

5 WHYS — AGENT PATH:
1. <why>
2. <why>
3. <why>
4. <why>
5. <why>
→ Agent root cause: <sentence>

HARNESS FIXES (in order of priority):
1. [LAYER] FILE: <path> — <what to add/change>
2. [LAYER] FILE: <path> — <what to add/change>
...

VERIFICATION: <how to confirm the fix prevents recurrence>
```

### Step 6: Implement

After user approval (or if invoked with `--fix`):
- Apply all harness fixes
- Run verification
- Report what was changed

## Decision Rules

- **If the same correction has been given twice**: This is a mandatory harness fix. No exceptions.
- **If the fix is a one-liner in code but the pattern could recur**: Harness fix first, code fix second.
- **If unsure whether it's a harness gap or a one-off**: Ask the user. Don't assume one-off.
- **Never add instructions that duplicate what's already documented**: Check first.
- **Prefer the most durable layer**: Instructions > Skills > Memory > Tests > CI
- **5 Whys are mandatory**: Never skip them. Short-circuit analysis produces shallow fixes.
- **Agent path is mandatory**: Never analyze only the technical dimension. Always ask why the agent failed too.

## Anti-patterns

- Adding a memory entry when the fix should be an instruction (memory is per-project; instructions are global)
- Writing a skill for a one-time operation
- Adding an integration test without also fixing the instruction that led to the bug
- Proposing CI gates for things that should be caught at the instruction level
- Over-engineering: adding 5 harness layers when 1 instruction would suffice
- Skipping the agent 5 Whys because "the technical fix is obvious"
- Assuming a harness layer works because it exists — verify it
