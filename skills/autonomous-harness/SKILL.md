---
name: autonomous-harness
description: Prompt-driven autonomous multi-agent coding harness. Generator/evaluator separation, sprint contracts, file-based handoffs. AO worker is the main primitive.
---

# Autonomous Harness — Prompt-Driven Multi-Agent Coding

## Overview

This skill implements a GAN-style autonomous coding harness using existing AO infrastructure:
- **AO worker** = main primitive (spawn via `ao spawn`)
- **Custom system prompts** = the harness logic (no new runtime, no code)
- **File-based handoffs** = state persistence between agents
- **Plugin-based** = no upstream Composio edits

## Architecture

```
brief
  │
  ▼
RESEARCHER ──→ research.md
  │
  ▼
STRATEGIST ──→ spec.md + plan.md
  │
  ▼
REVIEWER ──→ plan_review.md (L1 violations)
  │
  ▼
sprint_contract.md (negotiated, max 2 rounds)
  │
  ▼
GENERATOR ──→ sprint_N_report.md + git commit
  │
  ▼
EVALUATOR ──→ dual verdict (EVIDENCE + QUALITY)
  │
  ├─ EVIDENCE FAIL → evidence remediation (max 2 attempts)
  ├─ QUALITY FAIL → critique → GENERATOR (max 5 iters)
  └─ BOTH PASS → next sprint
```

## Usage

```
/autonomous-harness <brief> --sprints <N> --evaluator <agent>
```

## Execution

### Phase 1: Research
Read `prompts/researcher.md` and execute via AO worker:
```bash
ao spawn --agent <agent> --runtime process --system-prompt "$(cat prompts/researcher.md)" --project <project>
```

### Phase 2: Strategist
Read `prompts/strategist.md` — reads `research.md`, outputs `spec.md` + `plan.md`

### Phase 3: Reviewer
Read `prompts/reviewer.md` — reviews plan, outputs `plan_review.md` with L1 violations

### Phase 4: Sprint Loop
For each sprint N:
1. Negotiation: Generator proposes, Reviewer critiques (max 2 rounds) → `sprint_contract.md`
2. Generation: Generator implements per contract → `sprint_N_report.md` + git commit
3. Evaluation: Evaluator (skeptic) reads PR diff + evidence → `sprint_N_eval.md`

### Phase 5: Evaluation
Read `prompts/evaluator.md` — runs skeptic verify with CanonicalCodeScorer rubric

## Key Files

- `prompts/researcher.md` — "Research this codebase deeply..."
- `prompts/strategist.md` — "Given research.md, write spec.md + plan.md"
- `prompts/reviewer.md` — "Review plan, annotate L1 violations"
- `prompts/generator.md` — "Implement sprint N per contract"
- `prompts/evaluator.md` — "Evaluate using CanonicalCodeScorer rubric"
- `artifacts/harness_state.json` — State machine template
- `artifacts/sprint_contract.md` — Contract template

## Principles

1. **File-based handoffs** — all agents communicate via files only
2. **Sprint contracts** — scope locked before any code written
3. **Generator/evaluator separation** — evaluator never sees self-eval
4. **Context resets** — at 80% context or >90 min/sprint
5. **Dual verdict** — EVIDENCE + QUALITY both must pass

## Babysit Skill

See `babysit/SKILL.md` for worker lifecycle management (track, steer, recover).